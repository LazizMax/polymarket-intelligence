"""One-time authenticated import of the V2.0 source bundle.

The bundle must match the known SHA-256. Only app/, tests/ and installer/
regular files are extracted. Archive metadata, links and other paths are refused.
"""
from pathlib import Path, PurePosixPath
import base64
import hashlib
import io
import json
import stat
import sys
import tarfile

BUNDLE = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("bootstrap/polymarket-source.b64")
EXPECTED_SHA256 = "57bdd2980d73136d4d023a55b60e69705610bc58f88f258fc48b4fdacc3d16f8"
ALLOWED_ROOTS = {"app", "tests", "installer"}
ALLOWED_SUFFIXES = {".py", ".md", ".txt", ".toml", ".json", ".bat"}
REQUIRED = {"app/dashboard.py", "app/historical_db.py", "app/quality_metrics.py",
            "app/requirements.txt", "app/version.json", "installer/start_app.py"}
encoded = "".join(BUNDLE.read_text(encoding="ascii").split())
blob = base64.b64decode(encoded, validate=True)
if hashlib.sha256(blob).hexdigest() != EXPECTED_SHA256:
    raise SystemExit("Source archive checksum mismatch; refusing publication")
targets = []
total_bytes = 0
with tarfile.open(fileobj=io.BytesIO(blob), mode="r:xz") as archive:
    for member in archive.getmembers():
        path = PurePosixPath(member.name)
        if not path.parts or path.parts[0] not in ALLOWED_ROOTS:
            continue
        if not member.isfile() or path.is_absolute() or ".." in path.parts:
            raise SystemExit(f"Unsafe source entry: {member.name}")
        if path.suffix not in ALLOWED_SUFFIXES:
            raise SystemExit(f"Unexpected file type: {member.name}")
        if any(p in {"__pycache__", ".venv", "runs", "logs", "historical", "live_sessions", "updates"} for p in path.parts):
            raise SystemExit(f"Unexpected user data folder: {member.name}")
        total_bytes += member.size
        if total_bytes > 10 * 1024 * 1024:
            raise SystemExit("Source archive uncompressed size too large")
        targets.append((member, Path(*path.parts)))
    names = {str(path.as_posix()) for _, path in targets}
    if not REQUIRED <= names:
        raise SystemExit(f"Missing required source files: {REQUIRED - names}")
    for member, path in targets:
        path.parent.mkdir(parents=True, exist_ok=True)
        source = archive.extractfile(member)
        if source is None:
            raise SystemExit(f"Unreadable source entry: {member.name}")
        path.write_bytes(source.read())
version = json.loads(Path("app/version.json").read_text(encoding="utf-8"))["version"]
if version != "2.0.0":
    raise SystemExit("Unexpected source version; expected 2.0.0")
print(f"Imported {len(targets)} source files for version {version}, without personal data")
