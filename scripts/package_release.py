"""Package a code-only archive and an update manifest for GitHub Releases."""
from pathlib import Path
import hashlib
import json
import os
import zipfile

root = Path(__file__).resolve().parents[1]
app = root / "app"
version = json.loads((app / "version.json").read_text(encoding="utf-8"))["version"]
repo = os.environ.get("GITHUB_REPOSITORY", "LazizMax/polymarket-intelligence")
tag = f"v{version}"
out = root / "dist"
out.mkdir(exist_ok=True)
archive = out / "polymarket-code.zip"

allowed_suffix = {".py", ".md", ".txt", ".toml", ".json"}
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for path in sorted(app.rglob("*")):
        if not path.is_file():
            continue
        if any(part in {"__pycache__", ".venv", "runs", "historical", "logs", "live_sessions", "updates"} for part in path.parts):
            continue
        if path.suffix not in allowed_suffix:
            continue
        z.write(path, path.relative_to(root).as_posix())

manifest = {
    "version": version,
    "url": f"https://github.com/{repo}/releases/download/{tag}/polymarket-code.zip",
    "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()
}
(out / "latest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
print(json.dumps(manifest, indent=2))
