"""RN1 external bookmaker evidence pipeline must be private, bounded and causal."""
from pathlib import Path

BASE=Path(__file__).resolve().parents[1]
MIGRATION=(BASE/"sql/060_rn1_bounded_external_odds.sql").read_text()
SCHEDULE=(BASE/"sql/061_rn1_external_oracle_cron.sql").read_text()
COLLECTOR=(BASE/"supabase/functions/pi-rn1-odds/index.ts").read_text()
NORMALIZER=(BASE/"supabase/functions/pi-rn1-odds/normalize.ts").read_text()
DASH=(BASE/"supabase/functions/pi-dashboard/index.ts").read_text()
WEB=(BASE/"web/index.html").read_text()


def test_private_data_and_hard_caps():
    assert "enable row level security" in MIGRATION
    assert "revoke all on pi.rn1_external_odds_observations from public,anon,authenticated" in MIGRATION
    assert "revoke all on pi.rn1_external_odds_collector_state from public,anon,authenticated" in MIGRATION
    assert "source_event_id" in MIGRATION and "book_updated_at" in MIGRATION
    assert "first_seen_at timestamptz not null" in MIGRATION
    assert "RN1_ODDS_API_KEY" in COLLECTOR
    assert 'if(!await allowed(req))' in COLLECTOR
    assert 'requests:0' in COLLECTOR
    assert "calls>=24" in COLLECTOR
    assert "50*60e3" in COLLECTOR
    assert ">=5000" in COLLECTOR
    assert "5000-Number(count[0]?.n||0)" in COLLECTOR
    assert "'0 * * * *'" in SCHEDULE
    assert "vault.decrypted_secrets" in SCHEDULE
    assert "x-api-key" in COLLECTOR
    assert "console.error" in COLLECTOR
    assert "apiKey}" not in COLLECTOR


def test_only_real_pregame_odds_without_leakage():
    assert "start.getTime()<=now" in NORMALIZER
    assert "start.getTime()>now+72*3600e3" in NORMALIZER
    assert "time.getTime()>now+60_000" in NORMALIZER
    assert 'book.market!=="h2h"' in NORMALIZER
    assert "findTeam(o?.name)" in NORMALIZER
    assert "homeDay(start,home.zone)" in NORMALIZER
    assert "pHome/denom" in NORMALIZER and "pAway/denom" in NORMALIZER
    assert "first_seen_at:receivedAt.toISOString()" in NORMALIZER


def test_authenticated_unidentified_oracle_dashboard():
    assert 'if(body?.action==="rn1_oracle_evidence")' in DASH
    assert "async function rn1OracleEvidence()" in DASH
    assert "o.first_seen_at<=m.received_at" in DASH
    assert "o.start_at>m.received_at" in DASH
    assert "o.book_updated_at<=m.received_at" in DASH
    assert "training_enabled:false" in DASH
    assert 'api("rn1_oracle_evidence")' in WEB
    assert "M1 (oracle) et M2 (hybride) demeurent NON IDENTIFIABLES" in WEB
    assert "Ne pas saisir la clé ici ni dans GitHub" in WEB
