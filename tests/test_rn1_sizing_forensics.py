"""RN1 sizing analytics: full archive vs live pre-fill positions are distinct."""
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
API=(ROOT/"supabase/functions/pi-dashboard/index.ts").read_text()
FRONT=(ROOT/"web/index.html").read_text()
REPORT=(ROOT/"docs/RN1_SIZING_AND_PRETRADE_INVENTORY_2026-11-16.md").read_text()

def test_read_only_authenticated_action():
    assert 'if(!await allowed(req))' in API
    assert 'if(body?.action==="rn1_sizing_forensics")return send(await rn1SizingForensics());' in API
    assert 'async function rn1SizingForensics()' in API
    assert 'api("rn1_sizing_forensics")' in FRONT
    assert 'data-tab="sizing"' in FRONT
    assert 'async function renderRN1Sizing()' in FRONT

def test_no_post_fill_inventory_or_unknown_order_size():
    assert "r.position_observed_at<=r.received_at" in API
    assert "r.received_at<f.trade_at" in API
    assert "observed_outcomes=2" in API
    assert "f.fill_price*f.shares" in API
    assert "notional/nullif(market_cost,0)" in API
    assert "A public fill is not the underlying Maker order size" in API
    assert "NOT wallet bankroll fraction" in API

def test_full_archive_role_and_histogram_separation():
    assert "pi.rn1_pattern_page_stats" in API
    assert "jsonb_each(p.summary->'notional')" in API
    assert "role_status='verified'" in API
    assert "role='maker_inferred'" in API
    assert 'full_role_audit' in API
    assert "DEUX UNIVERS DISTINCTS" in FRONT
    assert "ni un pourcentage de bankroll" in FRONT
    assert "194 625 746,90" in REPORT
    assert "58,55 %" in REPORT
