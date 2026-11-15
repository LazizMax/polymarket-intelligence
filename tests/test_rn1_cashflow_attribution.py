"""RN1 economic attribution is gross, conditional and independently oracle-checked."""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
API=(ROOT/"supabase/functions/pi-dashboard/index.ts").read_text(encoding="utf-8")
WEB=(ROOT/"web/index.html").read_text(encoding="utf-8")
SQL=(ROOT/"sql/034_rn1_price_edge_cohort.sql").read_text(encoding="utf-8")

def test_cohort_is_frozen_event_diverse_and_private():
    assert "rn1_edge_v2" in SQL
    assert "sample_rank<=12" in SQL
    assert "partition by week,sides,band,event_slug" in SQL
    assert "max_trade_at < '2026-11-15T00:00:00+00'" in SQL
    assert "alter table pi.rn1_price_edge_cohort enable row level security;" in SQL
    assert "revoke all on pi.rn1_price_edge_cohort from public,anon,authenticated;" in SQL

def test_real_cashflow_not_theoretical_oracle_only():
    section=API.split("async function rn1EconomicAttribution(){",1)[1].split(
      "async function rn1ReverseEngineering(){",1)[0]
    assert "kind='REDEEM'" in section
    assert "kind='MERGE'" in section
    assert "b.buy0_shares>0 and b.buy1_shares>0" in section
    assert "redeemed>0 and payout_mismatch<=1 as reconciled" in section
    assert "least(abs(" in section
    assert "paired_gross" in section and "residual_gross" in section
    assert "pi.rn1_resolution_evidence" in section
    assert "matching_redeemed_within_cent" in section
    assert "Gross economic result excludes exchange fees" in section

def test_ui_does_not_claim_net_wallet_profit():
    assert "Résultat BRUT sur marchés réconciliés" in WEB
    assert "Contribution des paires YES/NO" in WEB
    assert "Contribution directionnelle résiduelle" in WEB
    assert "Ce n'est pas le PnL net du wallet" in WEB
    assert 'const economics=await rn1EconomicAttribution();' in API
    assert "markets_with_redemption" in API
