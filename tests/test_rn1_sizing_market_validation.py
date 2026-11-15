"""RN1 market-separated sizing model: no future positions and no cross-outcome leak."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API = (ROOT / "supabase/functions/pi-dashboard/index.ts").read_text()
WEB = (ROOT / "web/index.html").read_text()
REPORT = (ROOT / "docs/RN1_MAKER_SIZING_MARKET_VALIDATION_2026-11-16.md").read_text()

def test_authenticated_read_only_route_and_ui():
    assert 'if(!await allowed(req))' in API
    assert 'async function rn1SizingMarketValidation()' in API
    assert 'action==="rn1_sizing_market_validation"' in API
    assert 'api("rn1_sizing_market_validation")' in WEB
    assert 'Validation hors marchés connus' in WEB
    assert "Erreur médiane ×" in WEB

def test_market_holdout_instead_of_token_holdout():
    assert "function rn1MarketFold(s:string):number" in API
    assert "rn1MarketFold(String(x.market_key))!==fold" in API
    assert "rn1MarketFold(String(x.market_key))===fold" in API
    assert "for(let fold=0;fold<5;fold++)" in API
    assert 'const buckets=new Map<string,any[]>()' in API

def test_position_causality_and_unfilled_order_caveats():
    assert "r.position_observed_at<=r.received_at" in API
    assert "r.received_at<t.trade_at" in API
    assert "distinct_tokens=2" in API
    assert "prior_cost>0 and age<=60" in API
    assert "role='maker_inferred'" in API
    assert "Training from other markets only" in API
    assert "not time-causal" in API
    assert "No latent parent-order quantity" in API
    assert "Aucune formule fiable" in WEB
    assert "346 fills" in REPORT
    assert "×5,67" in REPORT

def test_multiple_model_competition_and_error_units():
    for name in ["global_fixed_shares","global_fixed_usdc",
                 "price_bucket_shares","price_bucket_usdc",
                 "price_inventory_shares","price_inventory_usdc",
                 "price_cost_shares","price_cost_usdc",
                 "fraction_open_market_cost"]:
        assert name in API
        assert name in WEB
    assert "Math.abs(Math.log(real/predictors[k]))" in API
    assert "median_error_factor" in API
    assert "equal_market_mean_abs_log_error" in API
    assert "×5,7" in REPORT
