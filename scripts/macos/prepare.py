"""Prepare the redistributable runtime natively on each macOS architecture."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

SOURCES = Path(__file__).resolve().parent
ROOT = SOURCES.parents[1]
LOCK = json.loads((SOURCES / "runtime-lock.json").read_text())


def digest(file):
    with file.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def archive(url, expected, destination, cache):
    file = cache / url.rsplit("/", 1)[1]
    if not file.exists() or digest(file) != expected:
        with tempfile.NamedTemporaryFile(dir=cache, delete=False) as tmp:
            with urllib.request.urlopen(url, timeout=120) as response:
                shutil.copyfileobj(response, tmp)
        candidate = Path(tmp.name)
        if digest(candidate) != expected:
            candidate.unlink()
            raise ValueError(f"SHA-256 mismatch for {file.name}")
        candidate.replace(file)
    with tarfile.open(file) as tar:
        tar.extractall(destination, filter="data")


def main():
    machines = {"arm64": ("arm64", "aarch64"), "x86_64": ("x64", "x86_64")}
    if platform.system() != "Darwin" or platform.machine() not in machines:
        raise SystemExit("Use the native Apple Silicon or Intel macOS runner.")
    arch, triple = machines[platform.machine()]
    stage = ROOT / "build" / "macos" / arch
    runtime = stage / "runtime"
    shutil.rmtree(runtime, ignore_errors=True)
    bins = runtime / "bin"
    bins.mkdir(parents=True)
    licenses = runtime / "licenses"
    licenses.mkdir()
    cache = stage.parent / "downloads"
    cache.mkdir(exist_ok=True)
    env = {**os.environ, "MACOSX_DEPLOYMENT_TARGET": LOCK["minimumSystemVersion"],
           "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "PYTHONDONTWRITEBYTECODE": "1"}
    with tempfile.TemporaryDirectory(dir=stage) as work:
        tmp = Path(work)
        node = LOCK["node"]
        name = f"node-v{node['version']}-darwin-{arch}"
        archive(f"https://nodejs.org/dist/v{node['version']}/{name}.tar.gz", node[arch], tmp, cache)
        shutil.copy2(tmp / name / "bin/node", bins / "node")
        shutil.copy2(tmp / name / "LICENSE", licenses / "Node-LICENSE")
        py = LOCK["python"]
        release = py["release"]
        name = f"cpython-{py['version']}+{release}-{triple}-apple-darwin-install_only.tar.gz"
        archive(f"https://github.com/astral-sh/python-build-standalone/releases/download/{release}/{name}", py[arch], runtime, cache)
        (bins / "python").symlink_to("../python/bin/python3")
        python = str(bins / "python")
        subprocess.run([python, "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--no-index",
                        "--no-compile", "--only-binary=:all:", "--require-hashes", "-r",
                        str(SOURCES / f"requirements-{arch}.txt")], env=env, check=True)
        subprocess.run([python, "-m", "pip", "check"], env=env, check=True)
        subprocess.run([python, "-c", "import av, ctranslate2, faster_whisper, onnxruntime, yt_dlp"], env=env, check=True)
        # Console wrappers contain absolute build-time shebangs. Desktop uses python -m.
        for script in (runtime / "python/bin").iterdir():
            if script.is_file() and not script.is_symlink():
                with script.open("rb") as handle:
                    scripted = handle.read(2) == b"#!"
                if scripted:
                    script.unlink()
        for script in (runtime / "python/bin").iterdir():
            if script.is_symlink() and not script.exists():
                script.unlink()
        ff = LOCK["ffmpeg"]
        name = f"ffmpeg-{ff['version']}"
        archive(f"https://ffmpeg.org/releases/{name}.tar.xz", ff["sha256"], tmp, cache)
        source = tmp / name
        subprocess.run(["./configure", "--disable-autodetect", "--disable-shared", "--enable-static",
                        "--disable-debug", "--disable-doc", "--disable-ffplay", "--disable-x86asm",
                        "--enable-zlib", "--enable-bzlib", "--enable-securetransport",
                        f"--extra-cflags=-mmacosx-version-min={LOCK['minimumSystemVersion']}",
                        f"--extra-ldflags=-mmacosx-version-min={LOCK['minimumSystemVersion']}"],
                       cwd=source, env=env, check=True)
        subprocess.run(["make", f"-j{os.cpu_count() or 2}", "ffmpeg", "ffprobe"], cwd=source, env=env, check=True)
        for tool in ("ffmpeg", "ffprobe"):
            shutil.copy2(source / tool, bins / tool)
            subprocess.run(["strip", "-x", str(bins / tool)], check=True)
            subprocess.run([str(bins / tool), "-version"], env=env, check=True)
        shutil.copy2(source / "COPYING.LGPLv2.1", licenses / "FFmpeg-LGPLv2.1")
    shutil.copy2(SOURCES / "runtime-lock.json", licenses)
    shutil.copy2(SOURCES / f"requirements-{arch}.txt", licenses)


if __name__ == "__main__":
    main()
