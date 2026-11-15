"""Regression: the browser must not present unvalidated RN1-like paper trades as strategy profits."""
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
UI = (ROOT / "web/index.html").read_text(encoding="utf-8")
API = (ROOT / "supabase/functions/pi-dashboard/index.ts").read_text(encoding="utf-8")


def test_frontend_no_longer_displays_fictitious_pnl_positions():
    assert "Résultat net hypothétique des positions fermées" not in UI
    assert "Jambe non couverte" not in UI
    assert "Paires papier" not in UI
    assert 'api("arb_observatory")' in UI
    assert "Stratégies rentables validées" in UI


def test_observatory_uses_bid_ask_snapshots_not_fake_fills():
    assert 'if(body?.action==="arb_observatory")return send(await arbObservatory());' in API
    assert "from pi.arb_temporal_snapshots" in API
    assert "yes_best_bid::float8 as yes_bid" in API
    assert "no_best_ask::float8 as no_ask" in API
    assert "observations:0" in API
    assert "DESCRIPTIVE_ONLY" not in UI  # never claim an execution status
