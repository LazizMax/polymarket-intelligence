"""RN1 causal-time sports robustness is descriptive and auditable."""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
API=(ROOT/"supabase/functions/pi-dashboard/index.ts").read_text()
WEB=(ROOT/"web/index.html").read_text()
REPORT=(ROOT/"docs/RN1_SPORTS_TRIGGER_CONDITIONAL_VALIDATION_2026-11-16.md").read_text()

def test_authenticated_route_and_on_demand_ui():
    assert 'if(!await allowed(req))' in API
    assert 'if(body?.action==="rn1_sports_robustness")return send(await rn1SportsRobustness());' in API
    assert 'async function rn1SportsRobustness()' in API
    assert 'api("rn1_sports_robustness")' in WEB
    assert 'Calculer les comparaisons appariées' in WEB
    assert 'Voir les différences match par match' in WEB

def test_design_no_future_leak():
    assert "h.resolution_seconds=60" in API
    assert "lag(h.observed_epoch)" in API
    assert "p.observed_epoch-p.prev_epoch between 60 and 180" in API
    assert "a.play_at>to_timestamp(p.prev_epoch)" in API
    assert "a.play_at<=to_timestamp(p.observed_epoch)" in API
    assert "t.reported_at>to_timestamp(p.observed_epoch)" in API
    assert "t.reported_at<=to_timestamp(p.observed_epoch)+interval '30 seconds'" in API
    assert "t.reported_at<=to_timestamp(p.observed_epoch)+interval '60 seconds'" in API

def test_token_phase_price_matching_and_caveats():
    assert "cross join (values(900),(1800),(3600))" in API
    assert "event_slug,token_id,phase_seconds,phase,magnitude,direction" in API
    assert "ns>=2 and nn>=2" in API
    assert 'equal_stratum_diff60_pp' in API
    assert 'equal_game_diff60_pp' in API
    assert "Conditioning on price may block the causal pathway" in API
    assert "Échantillon" in WEB or "échantillon" in WEB
    assert "Aucune rentabilité" in WEB
    assert "4 000 trades" in REPORT
