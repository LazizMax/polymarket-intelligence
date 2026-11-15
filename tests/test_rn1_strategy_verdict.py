"""RN1 wallet profitability proof must not be confused with copyability."""
from decimal import Decimal
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
UI=(ROOT/"web/index.html").read_text(encoding="utf8")
API=(ROOT/"supabase/functions/pi-dashboard-dedicated/index.ts").read_text(encoding="utf8")
OFFICIAL=(ROOT/"supabase/functions/pi-rn1-official-pnl/index.ts").read_text(encoding="utf8")
SCHEMA=(ROOT/"sql/053_rn1_official_pnl_private.sql").read_text(encoding="utf8")
VERDICT=(ROOT/"docs/RN1_STRATEGY_VERDICT_2026-11-15.md").read_text(encoding="utf8")

def test_native_economic_pnl_accounting_identity():
    official=Decimal("1112380.12")
    market=Decimal("669603.47")
    maker=Decimal("246169.45")
    taker=Decimal("132492.69")
    rewards=Decimal("99351.60")
    unrealized=Decimal("-35237.09")
    assert market+maker+taker+rewards+unrealized==official
    without_incentives=official-maker-taker-rewards
    assert without_incentives==Decimal("634366.38")
    volume=Decimal("115813998.06")
    assert Decimal("0.5")*volume/100 < without_incentives
    assert Decimal("0.75")*volume/100 > without_incentives

def test_market_pair_gross_is_separate_from_net():
    bought=Decimal("104750931.23")
    returned=Decimal("105800139.24")
    gross=Decimal("1049208.01")
    pair=Decimal("1326424.98")
    direction=Decimal("-277216.97")
    assert returned-bought==gross
    assert pair+direction==gross
    assert "+1 326 424,98 USDC" in VERDICT
    assert "pas un ROI sur capital" in VERDICT

def test_official_pnl_source_is_private_auth_and_lossless():
    assert "ENABLE ROW LEVEL SECURITY" in SCHEMA
    assert "REVOKE ALL ON pi.rn1_official_pnl_points FROM anon,authenticated" in SCHEMA
    assert "source_block" in SCHEMA and "record jsonb NOT NULL" in SCHEMA
    assert "x-pi-scheduler-token" in OFFICIAL
    assert "scheduler_auth" in OFFICIAL
    assert "($1::text)::jsonb" in OFFICIAL
    assert "JSON.parse(raw)" in OFFICIAL
    assert "jsonb_array_elements(points)" in OFFICIAL
    assert "interval=all&fidelity=1d" in OFFICIAL
    assert 'WALLET="0x2005d16a84ceefa912d4e380cd32e7ff827875ea"' in OFFICIAL

def test_verdict_separates_confirmed_pnl_and_unproven_copy():
    assert "async function rn1OfficialVerdict()" in API
    assert "official_verdict,role_audit:" in API
    assert "event_risk:eventRisk[0]||{}" in API
    assert "one_sided:oneSided[0]||{}" in API
    assert "Verdict RN1 : rentabilité passée confirmée" in UI
    assert "Copie automatique non encore validée" in UI
    assert "PnL / volume négocié (pas ROI capital)" in UI
    assert "Ne pas confondre volume brassé et bankroll" in UI
    assert "Taker" in VERDICT and "Maker" in VERDICT

def test_event_clustering_and_missing_redemptions_must_not_be_ignored():
    assert "coalesce(nullif(event_slug,''),market_key)" in API
    assert "top_1pct_gross" in API and "bottom_1pct_gross" in API
    assert "markets_without_redemption" in API
    assert "cost_without_observed_redemption" in API
    assert "Ne pas attribuer automatiquement une perte définitive" in UI
    assert "intervalle" in VERDICT.lower()
    assert "0 sur 1 891" in VERDICT
