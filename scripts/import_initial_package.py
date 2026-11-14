"""Safely unpack the one-time code-only V2.0 update ZIP into the source tree."""
from pathlib import Path, PurePosixPath
import json
import shutil
import stat
import sys
import zipfile

archive = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("Polymarket_Intelligence_MAJ_V2_0_Simplifiee.zip")
required = {"app/dashboard.py", "app/requirements.txt", "app/version.json", "app/historical_db.py"}
allowed = {".py", ".md", ".txt", ".toml", ".json"}
names = set()
size = 0
if not archive.is_file():
    raise SystemExit(f"Missing source archive: {archive}")
with zipfile.ZipFile(archive, "r") as zf:
    if len(zf.infolist()) > 200:
        raise SystemExit("Too many files in source archive")
    for info in zf.infolist():
        raw = info.filename.replace("\\", "/")
        path = PurePosixPath(raw)
        if info.is_dir():
            continue
        if path.is_absolute() or ".." in path.parts or len(path.parts) < 2 or path.parts[0] != "app":
            raise SystemExit(f"Unsafe archive entry: {raw}")
        if path.suffix not in allowed or any(x in path.parts for x in (".venv", "runs", "logs", "historical", "live_sessions", "updates", "__pycache__")):
            raise SystemExit(f"Unexpected archive entry: {raw}")
        if stat.S_IFMT(info.external_attr >> 16) == stat.S_IFLNK:
            raise SystemExit(f"Symlink not allowed: {raw}")
        size += info.file_size
        if size > 20 * 1024 * 1024:
            raise SystemExit("Archive too large")
        names.add(raw)
    if not required <= names:
        raise SystemExit("The source archive is missing required application files")
    for name in sorted(names):
        destination = Path(*PurePosixPath(name).parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        with zf.open(name) as src, destination.open("wb") as out:
            shutil.copyfileobj(src, out)
version = json.loads(Path("app/version.json").read_text(encoding="utf-8"))["version"]
print(f"Imported version {version} ({len(names)} code files), no user data.")
