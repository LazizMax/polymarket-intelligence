"""RN1 trigger dashboard must remain descriptive, causal in time, and private."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API = (ROOT / "supabase/functions/pi-dashboard/index.ts").read_text()
UI = (ROOT / "web/index.html").read_text()

def test_private_action_and_frontend_link():
    assert 'action==="rn1_trigger_windows"' in API
    assert "async function rn1TriggerWindows(body:any)" in API
    assert 'api("rn1_trigger_windows",{runs})' in UI
    assert 'data-tab="triggers"' in UI
    assert "async function renderRN1Triggers()" in UI
    assert "if(!await allowed(req))" in API

def test_no_future_book_and_no_post_fill_signal():
    assert "received_at>=book_at" in API
    assert "received_at-book_at<=interval '15 seconds'" in API
    assert "book_at-prev_at between interval '10 seconds' and interval '3 minutes'" in API
    assert "lag_seconds>=0 and lag_seconds<60" in API
    assert "lag(mid) over(partition by token_id" in API

def test_roles_filters_and_caveats_are_visible():
    assert "role='maker_inferred'" in API
    assert "role='taker_verified'" in API
    assert "spread between 0 and 0.10" in API
    assert "rn1_recent" in UI and "sports_control" in UI
    assert "NON apparié" in UI or "non appariés" in UI
    assert "PAS des décisions de déposer un ordre Maker" in UI
    assert "Aucune causalité" in UI
    assert "L'échantillon rn1_recent est sélectionné" in API
