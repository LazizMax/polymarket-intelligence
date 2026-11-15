"""RN1 pretrade position sampling must remain causally valid and fail closed."""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
PROBE=(ROOT/"supabase/functions/pi-rn1-quote-probe/index.ts").read_text()
UTIL=(ROOT/"supabase/functions/pi-rn1-quote-probe/quote-utils.ts").read_text()
API=(ROOT/"supabase/functions/pi-dashboard/index.ts").read_text()
WEB=(ROOT/"web/index.html").read_text()
SQL=(ROOT/"sql/037_rn1_quote_pretrade_inventory.sql").read_text()

def test_positions_requested_in_validated_short_market_batches():
    assert 'offset+=2' in PROBE, "Long condition filter is silently ignored"
    assert 'normalizeCurrentHoldings(response,subset,RN1)' in PROBE
    assert 'positionStatus="complete"' in PROBE
    assert 'positionStatus="unavailable"' in PROBE
    assert 'holdings=[];positionObservedAt=null' in PROBE
    assert 'status","OPEN"' in PROBE
    assert "response.pagination.has_more!==false" in UTIL
    assert "Unexpected wallet in position response" in UTIL
    assert "unrelated token" in UTIL
    assert "outcome index disagrees" in UTIL

def test_time_ordering_never_uses_future_inventory():
    assert PROBE.index("positionObservedAt=stamp()") < PROBE.index("const requestStarted=stamp();")
    assert "position_observed_at,position_status,positions" in PROBE
    assert "position_observed_at<=r.requested_at" in API
    assert "matchPreTradeBook(f,history,10,120)" in PROBE
    assert "position_status in('complete','unavailable')" in SQL
    assert "jsonb_typeof(positions)='array'" in SQL

def test_inventory_aware_quote_models_and_holdout_are_truthful():
    assert "inventory_one_tick" in API
    assert "inventory_two_ticks" in API
    assert "pair_ceiling_1pct" in API
    assert "pair_ceiling_2pct" in API
    assert "f.pre_bid>=3*(q->>'tick')::numeric" in API
    assert "rn1_quote_probe_fills" in API
    assert "position_observed_at<=r.requested_at" in API
    assert "Meilleure règle choisie" not in WEB or 'period==="train"' in WEB
    assert 'period==="train"' in WEB
    assert "pas du profit" in WEB
    assert "positions publiques" in WEB.lower()
