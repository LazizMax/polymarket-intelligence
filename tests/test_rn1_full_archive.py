"""RN1 archival contract: all source trades, deterministic private gzip, no false completeness."""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
INGEST=(ROOT/"supabase/functions/pi-ingest/index.ts").read_text(encoding="utf-8")
API=(ROOT/"supabase/functions/pi-dashboard/index.ts").read_text(encoding="utf-8")
UI=(ROOT/"web/index.html").read_text(encoding="utf-8")
SQL=(ROOT/"sql/027_rn1_full_public_archive.sql").read_text(encoding="utf-8")


def test_source_includes_both_maker_and_taker_and_full_history():
    assert 'taker_only:"false"' in INGEST
    assert 'start:"1",limit:"1000"' in INGEST
    assert 'stream==="trades_all"' in INGEST
    assert "data.length>1000" in INGEST


def test_archive_full_unmodified_response_and_preserve_resume():
    assert "source_response:response" in INGEST
    assert 'new CompressionStream("gzip")' in INGEST
    assert 'await uploadRN1Archive(key,payload)' in INGEST
    assert "insert into pi.rn1_full_archive_pages" in INGEST
    assert "next_cursor=$2" in INGEST
    assert "pages_fetched=$10 and next_cursor is not distinct from $11" in INGEST


def test_private_and_budgeted():
    assert "'pi-rn1-research-private','pi-rn1-research-private',false" in SQL
    assert "revoke all on pi.rn1_full_streams" in SQL
    assert "max_raw_bytes bigint" in SQL and "max_db_bytes bigint" in SQL
    assert "pg_database_size(current_database())" in INGEST
    assert "paused_quota" in INGEST
    assert "SUPABASE_SERVICE_ROLE_KEY" in INGEST
    assert "uploadRN1Archive" in INGEST
    assert "status=case when $9::boolean then 'source_exhausted'" in INGEST


def test_ui_retires_old_taker_only_pilot_from_primary_analysis():
    assert 'api("rn1_reverse_engineering")' in UI
    assert 'async function rn1ReverseEngineering()' in API
    assert "le précédent échantillon de 4 000 transactions utilisait le filtre taker" in UI
    assert "Le nombre total de transactions n'est pas fourni" in UI
