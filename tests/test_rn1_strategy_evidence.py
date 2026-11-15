"""RN1 evidence must be reproducible and never label conditional payouts as real PnL."""
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
API = (ROOT / "supabase/functions/pi-dashboard/index.ts").read_text(encoding="utf-8")
UI = (ROOT / "web/index.html").read_text(encoding="utf-8")
EVIDENCE = (ROOT / "sql/025_rn1_fill_price_benchmark.sql").read_text(encoding="utf-8")
BACKFILL = (ROOT / "sql/026_rn1_price_benchmark_backfill.sql").read_text(encoding="utf-8")


def test_research_is_authenticated_and_read_only():
    assert 'if(body?.action==="rn1_strategy_evidence")return send(await rn1StrategyEvidence());' in API
    assert "if(!await allowed(req))" in API
    assert "pi.rn1_resolution_evidence" in API
    assert "pi.rn1_fill_price_benchmark" in API


def test_hypothetical_return_is_not_realized_profit():
    assert "hypothetical_gross_pnl" in API
    assert "directional_residual" in API
    assert "historical one-minute price point is NOT" in API
    assert "SCÉNARIOS d'achats conservés" in UI
    assert "Ce ne sont pas les profits réels" in UI
    assert "n'existe pas encore de preuve" in UI


def test_price_reference_has_no_lookahead():
    assert "resolution_seconds<=t.ts" in BACKFILL
    assert "resolution_seconds>=t.ts-120" in BACKFILL
    assert "h.observed_epoch between t.ts+900 and t.ts+1020" in BACKFILL
    assert "h.observed_epoch+h.resolution_seconds<=t.resolution_ts" in BACKFILL
    assert "reference_epoch+coalesce(reference_width_seconds,0)<=extract(epoch from bought_at)" in EVIDENCE


def test_first_choice_is_market_probability_baseline():
    assert "expected_winners_from_prices" in API
    assert "count(distinct t.event_slug)" in API
    assert "row_number() over(partition by b.market_key" in API
    assert "async function renderRN1StrategyEvidence(target)" in UI
    assert "await renderRN1StrategyEvidence(target)" not in UI  # intentionally hidden from concise RN1 view
