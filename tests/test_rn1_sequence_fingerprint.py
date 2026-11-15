"""RN1 sequence audit must treat visible execution flow as a proxy, not real inventory."""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
INGEST=(ROOT/"supabase/functions/pi-ingest/index.ts").read_text(encoding="utf-8")
SEQ=(ROOT/"supabase/functions/pi-ingest/rn1-sequence.ts").read_text(encoding="utf-8")
API=(ROOT/"supabase/functions/pi-dashboard/index.ts").read_text(encoding="utf-8")
UI=(ROOT/"web/index.html").read_text(encoding="utf-8")
SQL=(ROOT/"sql/032_rn1_sequence_flow_fingerprint.sql").read_text(encoding="utf-8")

def test_chronology_is_frozen_and_oldest_first():
    assert "max(page_no),max(page_no)" in SQL
    assert 'returning next_page,cohort_last_page' in INGEST
    assert 'rows[i]?.timestamp)>Number(rows[i-1]?.timestamp)' in INGEST
    assert 'for(let i=rows.length-1;i>=0;i--)' in SEQ
    assert "status=case when next_page=1 then 'complete'" in INGEST

def test_source_checks_before_cursor_advancement():
    assert 'new DecompressionStream("gzip")' in INGEST
    assert 'if(await sha256(raw)!==p[0].sha256)' in INGEST
    assert 'if(norm.length!==rows.length)' in INGEST
    assert 'await db.begin(async tx=>' in INGEST
    assert 'from pi.rn1_sequence_market_state' in INGEST
    assert 'insert into pi.rn1_sequence_page_stats' in INGEST

def test_not_misleading_pnl_or_portfolio():
    assert 'The signed buy/sell shares are NOT actual wallet inventory' in SEQ
    assert 'Les règlements, fusions et inventaires antérieurs manquent' in UI
    assert "comparable_buy_fills" in API
    assert "overcorrects_buys" in SEQ
    assert "status in('running','complete','paused_quota','paused_error')" in SQL
    assert 'alter table pi.rn1_sequence_page_stats enable row level security' in SQL
