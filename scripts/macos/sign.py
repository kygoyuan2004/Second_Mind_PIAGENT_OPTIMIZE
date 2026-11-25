"""Validate Darwin load commands and ad-hoc sign native code from the inside out."""
from pathlib import Path
import os
import platform
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
for directory, folders, files in os.walk(APP, topdown=False):
    folder = Path(directory)
    for name in files:
        path = folder / name
        if path.is_symlink() or not path.is_file():
            continue
        with path.open("rb") as stream:
            native = stream.read(4) in MACH
        if native:
            if path.is_relative_to(RUNTIME):
                audit(path)
            sign(path)
    if folder.suffix == ".framework":
        sign(folder)
    elif folder.suffix in (".app", ".xpc"):
        sign(folder, executable_bundle=True)
subprocess.run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(APP)], check=True)
