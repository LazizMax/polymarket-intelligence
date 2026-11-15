"""Contracts for the private RN1 chronological large-sample replay.
The algorithm is execution-flow reconstruction, not an account ledger.
"""
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
SOURCE=(ROOT/"supabase/functions/pi-rn1-replay/index.ts").read_text(encoding="utf8")
SCHEMA=(ROOT/"sql/046_rn1_large_replay_private_schema.sql").read_text(encoding="utf8")
SCHEDULE=(ROOT/"sql/047_rn1_large_replay_schedule.sql").read_text(encoding="utf8")
API=(ROOT/"supabase/functions/pi-dashboard/index.ts").read_text(encoding="utf8")
UI=(ROOT/"web/index.html").read_text(encoding="utf8")

def test_private_archive_provenance_and_checkpointing():
    assert "new DecompressionStream(\"gzip\")" in SOURCE
    assert "new CompressionStream(\"gzip\")" in SOURCE
    assert "await sha(rawText)" in SOURCE
    assert "page.sha256" in SOURCE
    assert "pi-rn1-research-private" in SOURCE
    assert "if(job.snapshot_key)await deleteObject" in SOURCE
    assert "ON CONFLICT(page_no) DO NOTHING" in SOURCE
    assert "WHERE job_key=$1 AND next_page=$9" in SOURCE

def test_per_fill_role_inference_fail_closed():
    assert 'u.searchParams.set("taker_only","true")' in SOURCE
    assert 'role_status!=="verified"' in SOURCE
    assert 'counts.maker!==Number(expected.maker_fills)' in SOURCE
    assert 'counts.taker!==Number(expected.taker_fills)' in SOURCE
    assert ':"unknown"' in SOURCE or '"unknown"' in SOURCE

def test_causal_inventory_and_price_proxy_not_clob():
    assert "for(let i=raw.length-1;i>=0;i--)" in SOURCE
    assert "const beforeGap=Math.abs(h.q0-h.q1)" in SOURCE
    assert "const newPairs=Math.max(0,Math.min(h.q0,h.q1)-beforePaired)" in SOURCE
    assert "observeFuture(state,token,price,at)" in SOURCE
    assert "at>=lower&&at<=upper" in SOURCE
    assert "GRACE=[120,300,600,900,1800]" in SOURCE
    assert "Drop waiting fills whose entire future-trade observation window" in SOURCE
    assert "NOT external" in SOURCE or "NOT independent" in SOURCE

def test_private_rls_and_auth_no_plaintext_token():
    assert "ENABLE ROW LEVEL SECURITY" in SCHEMA
    assert "REVOKE ALL ON pi.rn1_replay_jobs FROM anon,authenticated" in SCHEMA
    assert "REVOKE ALL ON pi.rn1_replay_pages FROM anon,authenticated" in SCHEMA
    assert "if(!await authorized(req))" in SOURCE
    assert "pi_ingest_scheduler_token" in SCHEDULE
    assert "Vault-backed" in SCHEDULE

def test_dashboard_publication_does_not_call_proxy_true_alpha():
    assert "full_replay:fullReplay[0]||null" in API
    assert "Relecture Maker/Taker des archives RN1" in UI
    assert "DU MÊME WALLET" in UI
    assert "ni sélection " in UI or "ni bénéfice réalisé" in UI

def test_position_stratification_is_visible_with_denominators():
    assert "Comparaison Maker : côté moins accumulé ou déjà dominant" in UI
    assert 'row["maker|"+position]' in UI
    assert "maker>0?fmt(100*reference15/maker,1)" in UI
    assert "ne participent pas au prix moyen" in UI
    assert "pas de performance d'ordres théoriques" in UI
