"""Regression: Polymarket event URLs must use Gamma's event slug, not market slug."""
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
CAPTURE = (ROOT / "supabase/functions/pi-ingest/arb-capture.ts").read_text()
DASH = (ROOT / "supabase/functions/pi-dashboard/index.ts").read_text()
UI = (ROOT / "web/index.html").read_text()
LEDGER = (ROOT / "supabase/functions/pi-ingest/index.ts").read_text()


def test_market_slug_not_used_for_event_links():
    assert 'encodeURIComponent(r.event_slug)' in UI
    assert 'encodeURIComponent(r.slug)' not in UI
    assert 'encodeURIComponent(r.slug||"")' not in UI


def test_gamma_event_slug_is_captured_separately():
    assert 'm.events[0]?.slug' in CAPTURE
    assert 'm.events[0]?.slug' in DASH
    assert 'market_slug:m.slug,event_slug:m.event_slug' in CAPTURE
    assert 'slug:m.slug,event_slug:m.event_slug' in DASH


def test_temporal_storage_carries_metadata_through():
    assert "x.market_slug,x.event_slug,x.question" in LEDGER
    assert "event_slug text" in LEDGER
    assert "select observed_at::text,market_key,market_slug,event_slug" in DASH
