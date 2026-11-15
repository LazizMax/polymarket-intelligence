"""RN1 post-fill markouts: enforce causal future-book and economic caveats."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
API = (ROOT / "supabase/functions/pi-dashboard/index.ts").read_text(encoding="utf-8")
UI = (ROOT / "web/index.html").read_text(encoding="utf-8")


def markout_query():
    found = re.search(r"const markouts=await db\.unsafe\(`([\s\S]*?)`\);", API)
    assert found, "post-fill markout query must be present"
    return found.group(1)


def test_markouts_use_only_subsequent_nonstale_books():
    sql = markout_query()
    assert "r.received_at between f.trade_at+h.lo" in sql
    assert "and (j->>'book_at')::numeric>=extract(epoch from f.trade_at)*1000" in sql
    assert "j->>'asset_id'=f.token_id" in sql
    assert "j->>'book_valid'='true'" in sql
    assert "partition by f.fingerprint,h.horizon order by r.received_at" in sql
    assert "where rn=1" in sql


def test_markouts_keep_market_and_same_cohort_coverage():
    sql = markout_query()
    assert "count(distinct market_key)::int markets" in sql
    assert "count(distinct trade_at::date)::int days" in sql
    assert "having count(distinct horizon)=3" in sql
    assert "same_fills_weighted_markout" in sql
    assert "quantity_weighted_markout_per_share" in sql


def test_ui_does_not_label_markouts_as_realized_profit():
    assert "RN1 — évolution du prix après achat" in UI
    assert "ni vente exécutée, ni PnL, ni ROI" in UI
    assert "Même groupe observable aux trois horizons" in UI
    assert "q.markouts" in UI
