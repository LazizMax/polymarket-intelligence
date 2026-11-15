"""RN1 NBA play-by-play evidence uses historical wallclock, private tables and causal buckets."""
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
COLLECT=(ROOT/"supabase/functions/pi-rn1-sports-events/index.ts").read_text()
API=(ROOT/"supabase/functions/pi-dashboard/index.ts").read_text()
FRONT=(ROOT/"web/index.html").read_text()
SCHEMA=(ROOT/"sql/058b_rn1_nba_espn_event_evidence.sql").read_text()
PARTIAL=(ROOT/"sql/058c_rn1_nba_partial_game_accuracy.sql").read_text()
SCHEDULE=(ROOT/"sql/059_rn1_nba_espn_sports_event_sync.sql").read_text()

def test_collector_auth_and_true_sport_timestamps():
    assert "async function authorized(req:Request)" in COLLECT
    assert 'x-pi-scheduler-token' in COLLECT
    assert 'const timestamp=epoch(p?.wallclock)' in COLLECT
    assert 'No unique NBA game match on ESPN scoreboard' in COLLECT
    assert "found.length===1" in COLLECT
    assert 'site.web.api.espn.com/apis/site/v2/sports/basketball/nba/summary' in COLLECT
    assert "sha256(text)" in COLLECT
    assert "on conflict(event_slug,play_id) do nothing" in COLLECT

def test_finality_and_historical_priority():
    assert "const finalized=game?.status?.type?.completed===true" in COLLECT
    assert "status:finalized?'complete':'partial'" in COLLECT
    assert "game_day<current_date" in COLLECT
    assert "updated_at<now()-interval '15 minutes'" in COLLECT

def test_private_tables_and_bounded_schedule():
    for name in ("rn1_nba_espn_links","rn1_nba_espn_scoreboards","rn1_nba_espn_plays"):
        assert name in SCHEMA
        assert 'enable row level security' in SCHEMA
    assert "check(status in('pending','working','complete','partial','missing','error'))" in PARTIAL
    assert 'pi_ingest_scheduler_token' in SCHEDULE
    assert 'nba_event_sync' in SCHEDULE
    assert "where exists(" in SCHEDULE

def test_auth_read_only_and_ui_provenance():
    assert 'action==="rn1_sports_impact"' in API
    assert "async function rn1SportsImpact(body:any)" in API
    assert "last_play_at" in API
    assert "quarter_rank" in API
    assert "lead_change" in API
    assert "Les 4 000 exécutions proviennent d'un feed Taker-only implicite" in API
    assert 'api("rn1_sports_impact"' in FRONT
    assert 'data-tab="sports"' in FRONT
    assert 'async function renderRN1Sports()' in FRONT
    assert "donc du flux Taker-only implicite" in FRONT


def test_legacy_pilot_not_mistaken_for_maker_universe():
    assert "taker_only=false" in API
    assert "Taker-only" in FRONT
    assert "89,2 % sont Maker" in API
