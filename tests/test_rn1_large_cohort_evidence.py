"""RN1 large-cohort evidence contracts: no cross-cohort profit claims."""
from pathlib import Path
import re

ROOT=Path(__file__).resolve().parents[1]
API=(ROOT/"supabase/functions/pi-dashboard/index.ts").read_text(encoding="utf-8")
UI=(ROOT/"web/index.html").read_text(encoding="utf-8")
SQL=(ROOT/"sql/rn1_postfill_inventory_large_cohorts.sql").read_text(encoding="utf-8")

def test_economic_by_skew_requires_reconciliation():
    m=re.search(r"const skewImpact=await db\.unsafe\(base\+`([\s\S]*?)`\);",API)
    assert m
    assert "from checked where reconciled" in m.group(1)
    assert "greatest(buy0_shares,buy1_shares)" in m.group(1)
    assert "sum(residual_gross)" in m.group(1)

def test_dashboard_names_large_cohorts_and_no_causal_attribution():
    assert "Pourquoi le déséquilibre YES/NO compte" in UI
    assert "a posteriori, non attribuable à un ordre individuel" in UI
    assert "severe.events" in UI

def test_all_required_cohorts_and_safety_controls_documented():
    assert "pi.rn1_sequence_page_stats" in SQL
    assert "from grouped group by 1" in SQL
    assert "pi.rn1_full_market_metrics" in SQL
    assert "where redeemed>0 and mismatch<=1" in SQL
    assert "pi.rn1_fill_price_benchmark" in SQL
    assert "and after_15m_epoch>extract(epoch from bought_at)" in SQL
    assert "pi.rn1_full_archive_pages" in SQL
    assert "Maker inference is verified on" in SQL or "maker inference is verified on" in SQL.lower()
