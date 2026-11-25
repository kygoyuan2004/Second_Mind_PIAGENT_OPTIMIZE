"""Validate Darwin load commands and ad-hoc sign native code from the inside out."""
from pathlib import Path
import os
import platform
import plistlib
import re
import stat
import subprocess
import tempfile
import sys

MACH = {bytes.fromhex(x) for x in ("feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca")}
APP = Path(sys.argv[1]).resolve()
RUNTIME = APP / "Contents/Resources/runtime"


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def relocatable(value):
    return (value.startswith(("/usr/lib/", "/System/Library/", "@loader_path/", "@executable_path/", "@rpath/"))
            or value in ("@loader_path", "@executable_path"))


def load_path(value, source):
    if not relocatable(value):
        raise ValueError(f"Non-relocatable Mach-O load path {value!r} in {source.relative_to(APP)}")


def normalize(path, cpu):
    # Wheels may carry the builder's LC_ID_DYLIB or unused search paths even
    # when all imports already point at the private copy next to the extension.
    arches = command("lipo", "-archs", path).split()
    if cpu not in arches:
        raise ValueError(f"Wrong CPU architecture in {path.relative_to(APP)}")
    if len(arches) > 1:
        mode = stat.S_IMODE(path.stat().st_mode)
        with tempfile.TemporaryDirectory(dir=path.parent) as temporary:
            native = Path(temporary) / path.name
            subprocess.run(["lipo", path, "-thin", cpu, "-output", native], check=True)
            native.chmod(mode)
            native.replace(path)
    commands = command("otool", "-l", path)
    options = []
    identity = re.search(r"cmd LC_ID_DYLIB\s+cmdsize \d+\s+name (.*?) \(offset \d+\)", commands)
    if identity and not relocatable(identity.group(1)):
        options.extend(["-id", "@rpath/" + path.name])
    for entry in re.findall(r"cmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset \d+\)", commands):
        if not relocatable(entry):
            options.extend(["-delete_rpath", entry])
    if options:
        subprocess.run(["install_name_tool", *options, path], check=True)


def audit(path):
    cpu = platform.machine()
    normalize(path, cpu)
    for line in command("otool", "-arch", cpu, "-L", path).splitlines()[1:]:
        if " (compatibility version" in line:
            load_path(line.strip().split(" (compatibility version")[0], path)
    commands = command("otool", "-arch", cpu, "-l", path)
    for entry in re.findall(r"cmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset \d+\)", commands):
        load_path(entry, path)


def sign(path, executable_bundle=False):
    args = ["codesign", "--force", "--sign", "-", "--timestamp=none"]
    if executable_bundle:
        args.extend(["--entitlements", str(Path(__file__).with_name("entitlements.plist"))])
    subprocess.run([*args, str(path)], check=True)


if not (RUNTIME / "bin/node").is_file():
    raise SystemExit("Packaged Darwin runtime is missing")
# codesign treats a bundle's declared executable as the entire bundle. Signing
# Contents/MacOS first can therefore try to seal unsigned sibling frameworks.
bundles = []
executables = set()
native_files = []
for directory, folders, files in os.walk(APP):
    folder = Path(directory)
    if folder.suffix in (".framework", ".app", ".xpc"):
        if folder.suffix == ".framework":
            contents = folder / "Versions/Current" if (folder / "Versions/Current").exists() else folder
            info = contents / "Resources/Info.plist"
            binaries = contents
        else:
            info = folder / "Contents/Info.plist"
            binaries = folder / "Contents/MacOS"
        with info.open("rb") as stream:
            name = plistlib.load(stream)["CFBundleExecutable"]
        executables.add((binaries / name).resolve(strict=True))
        bundles.append(folder)
    for name in [*folders, *files]:
        path = folder / name
        if path.is_symlink():
            target = path.resolve(strict=True)
            if path.readlink().is_absolute() or not target.is_relative_to(APP):
                raise ValueError(f"Non-portable link in {path.relative_to(APP)}")
        elif path.is_file():
            with path.open("rb") as stream:
                if stream.read(4) in MACH:
                    native_files.append(path)

for path in native_files:
    if path.is_relative_to(RUNTIME):
        audit(path)
    if path not in executables:
        sign(path)

# All loose code is signed before any nested bundle. Seal parents last.
for bundle in sorted(bundles, key=lambda entry: len(entry.parts), reverse=True):
    sign(bundle, executable_bundle=bundle.suffix in (".app", ".xpc"))
subprocess.run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(APP)], check=True)
