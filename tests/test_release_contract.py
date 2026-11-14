import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"


def test_release_has_required_sources():
    for file in ("dashboard.py", "historical_db.py", "requirements.txt", "version.json", "quality_metrics.py"):
        assert (APP / file).is_file(), f"Missing {file}"


def test_release_version_is_semver():
    version = json.loads((APP / "version.json").read_text(encoding="utf-8"))["version"]
    parts = version.split(".")
    assert len(parts) == 3 and all(p.isdigit() for p in parts)


def test_source_does_not_publish_local_data():
    forbidden = {".env", "settings.json", "historique.sqlite"}
    assert not any(p.name in forbidden for p in APP.rglob("*"))


def test_dashboard_has_three_main_pages():
    source = (APP / "dashboard.py").read_text(encoding="utf-8")
    assert "Classements" in source
    assert "Profils" in source
    assert "Collecte" in source
