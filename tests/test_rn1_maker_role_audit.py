"""Maker-role audit must use immutable source pages and exact per-fill multiset matching."""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
INGEST=(ROOT/"supabase/functions/pi-ingest/index.ts").read_text(encoding="utf-8")
UI=(ROOT/"web/index.html").read_text(encoding="utf-8")
API=(ROOT/"supabase/functions/pi-dashboard/index.ts").read_text(encoding="utf-8")
SQL=(ROOT/"sql/030_rn1_maker_role_audit.sql").read_text(encoding="utf-8")

def test_role_worker_requires_scheduler_and_source_validation():
    assert 'if (body?.action === "rn1_maker_audit_scheduled")' in INGEST
    assert 'if (!await schedulerAllowed(req))' in INGEST
    assert 'new DecompressionStream("gzip")' in INGEST
    assert 'if(await sha256(unzipped)!==p.sha256)' in INGEST
    assert 'taker_only:"true"' in INGEST
    assert "matchMakerTaker(full,taker)" in INGEST


def test_verified_only_sums_and_public_ui():
    assert "role_status='verified'" in INGEST
    assert "role_status in('pending','error')" in INGEST
    assert "maker_fills+taker_fills=valid_count" in SQL
    assert "sum(maker_fills) filter(where role_status='verified')" in API
    assert "role_audit:role[0]" in API
    assert "Exécutions maker (audit Polymarket)" in UI
    assert "Elle ne porte encore que sur les pages auditées" in UI
