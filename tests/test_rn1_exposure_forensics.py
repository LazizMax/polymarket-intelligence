"""RN1 sampled exposure and binary-outcome inventory provenance CI contract."""
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
EDGE = (BASE / "supabase/functions/pi-dashboard/index.ts").read_text(encoding="utf-8")
WEB = (BASE / "web/index.html").read_text(encoding="utf-8")
REPORT = (BASE / "docs/RN1_EXPOSURE_AND_POSITION_TRANSITIONS_2026-11-16.md").read_text(encoding="utf-8")

def test_authenticated_read_only_action_and_ui():
    assert "if(!await allowed(req))" in EDGE
    assert 'async function rn1ExposureForensics()' in EDGE
    assert 'if(body?.action==="rn1_exposure_forensics")' in EDGE
    assert 'api("rn1_exposure_forensics")' in WEB
    assert 'data-tab="exposure"' in WEB
    assert 'tab==="exposure"' in WEB
    assert 'async function renderRN1Exposure()' in WEB

def test_exact_selected_market_vs_wallet_scope():
    assert "order by received_at desc,id desc limit 2000" in EDGE
    assert "position_status='complete'" in EDGE
    assert "position_observed_at<=received_at" in EDGE
    assert "token_rows=2 and shares_0>=0 and shares_1>=0" in EDGE
    assert "sum(coalesce((x->>'entry_cost_usdc')::numeric,0))" in EDGE
    assert "returned_by_api" in EDGE
    assert "api_tokens=2 and prev_api_tokens=2" in EDGE
    assert "zero_imputation_involved" in EDGE
    assert "8 marchés" in WEB
    assert "pas une limite de risque" in WEB.lower() or "n'est PAS une limite" in WEB

def test_market_only_temporal_transitions():
    assert "lag(observed_epoch)over(partition by market_key" in EDGE
    assert "observed_epoch-prev_at<=180" in EDGE
    assert "abs(shares_0-shares_1)-abs(prev_0-prev_1)" in EDGE
    assert "least(shares_0,shares_1)-least(prev_0,prev_1)" in EDGE
    assert "strictly_confirmed_gap_reduced" in EDGE
    assert "strictly_confirmed_gap_increased" in EDGE
    assert "changed_with_matched_fills" in EDGE

def test_event_concentration_and_conditional_downside():
    assert "x->>'event_slug'" in EDGE
    assert "group by run_id,event_slug" in EDGE
    assert "max(selected_markets)" in EDGE
    assert "greatest(0,entry_cost-least(shares_0,shares_1))" in EDGE
    assert "median_conditional_terminal_downside" in EDGE
    assert "median_selected_downside_bound" in EDGE
    assert "Borne de perte" in WEB
    assert 'document.createElementNS(svgNS,"path")' in WEB
    assert "VaR" in WEB and "Value at Risk" in REPORT
    assert "128" in REPORT and "149" in REPORT

def test_no_unwarranted_bankroll_or_executable_edge_claims():
    assert "NOT all-wallet exposure" in EDGE or "NOT all-wallet" in EDGE
    assert "NOT RN1's position limit" in EDGE
    assert "No net ROI" in EDGE
    assert "aucune transaction" in REPORT
    assert "756 000" in REPORT
