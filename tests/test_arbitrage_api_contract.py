"""Protect Polymarket's two independent public API request contracts.

The 2026-11-15 production incident was:
  Gamma /markets: invalid 'volume_24hr' sort => HTTP 422
  CLOB /books: expects JSON array, not {'params': [...]}.
These assertions validate the deployed call-site, not an unrelated mock.
"""
from pathlib import Path

SOURCE = (Path(__file__).parents[1] / "supabase/functions/pi-dashboard/index.ts").read_text(
    encoding="utf-8"
)


def test_gamma_market_sort_contract():
    assert 'order:"volume24hr"' in SOURCE
    assert 'order:"volume_24hr"' not in SOURCE


def test_clob_books_post_array_payload_contract():
    assert 'body:JSON.stringify(params)' in SOURCE
    assert 'body:JSON.stringify({params})' not in SOURCE
