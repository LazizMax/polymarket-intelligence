"""RN1 historical-first diagnostic: reuse all existing archives, no forward-leakage."""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
EDGE=(ROOT/"supabase/functions/pi-dashboard/index.ts").read_text()
UI=(ROOT/"web/index.html").read_text()
REPORT=(ROOT/"docs/RN1_HISTORICAL_REVERSE_ENGINEERING_PIVOT_2026-11-16.md").read_text()

def test_historical_endpoint_and_ui():
    assert "async function rn1HistoricalResearch()" in EDGE
    assert 'if(body?.action==="rn1_historical_research")return send(await rn1HistoricalResearch());' in EDGE
    assert 'api("rn1_historical_research")' in UI
    assert "Priorité · Reconstituer les décisions depuis l’historique" in UI

def test_coverage_and_truthful_data_limits():
    assert "pi.rn1_full_archive_pages where stream='trades_all'" in EDGE
    assert "pi.rn1_historical_price_points" in EDGE
    assert "pi.rn1_nba_espn_plays" in EDGE
    assert "pi.rn1_trade_pages" in EDGE
    assert "p.observed_epoch between pilot.trade_epoch-60 and pilot.trade_epoch" in EDGE
    assert "compressed_full_archive_already_exists_needs_targeted_decompression" in EDGE
    assert "historical_bookmaker_snapshots_not_present_in_project" in EDGE
    assert "Taker-only" in EDGE or "Taker-only" in REPORT

def test_no_invented_oracle_evidence():
    assert "un oracle bookmaker indépendant" in UI
    assert "ne doit jamais être présentée" in UI
    assert "Le produit historique contient" not in UI
    assert "The Odds API" in REPORT
    assert "holdout" in REPORT.lower() or "événement" in REPORT
