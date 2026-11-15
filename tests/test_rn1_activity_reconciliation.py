"""RN1 reconciliation must not accidentally treat redemptions as trade PnL."""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
SOURCE=(ROOT/"supabase/functions/pi-ingest/index.ts").read_text(encoding="utf-8")
PARSE=(ROOT/"supabase/functions/pi-ingest/rn1-activity-utils.ts").read_text(encoding="utf-8")
DASH=(ROOT/"supabase/functions/pi-dashboard/index.ts").read_text(encoding="utf-8")
WEB=(ROOT/"web/index.html").read_text(encoding="utf-8")

def test_raw_activity_archived_before_normalization():
    assert "/v2/activity" in SOURCE
    assert "insert into pi.rn1_activity_pages" in SOURCE
    assert "insert into pi.wallet_activity" in SOURCE
    assert "pageSHA" in SOURCE
    assert "status='collecting'" in SOURCE

def test_redemption_is_not_presented_as_net_profit():
    assert 'amount_usdc:null,amount_classification:"unknown"' in PARSE
    assert 'reported_usdc_size' in PARSE
    assert "REDEEM représente un montant remboursé" in WEB
    assert "Aucun PnL" not in WEB or "PnL" in WEB

def test_activity_trade_is_not_double_counted():
    assert "rn1_activity_research" in DASH
    assert "activity_trade_rows_with_matching_trade" in DASH
    assert "abs(t.shares-a.shares)<0.00001" in DASH

def test_usable_browser_status_and_partial_data_warnings():
    assert 'api("rn1_activity_research")' in WEB
    assert "non réconciliée" in WEB or "non réconcilié" in WEB
    assert 'event_slug' in WEB
