"""Prevent misleading pooled quote offsets and false instant-arbitrage claims."""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
API=(ROOT/"supabase/functions/pi-dashboard/index.ts").read_text(encoding="utf-8")
UI=(ROOT/"web/index.html").read_text(encoding="utf-8")

def test_age_specific_maker_fills_are_separate():
    for field in (
        "maker_recent_under30", "maker_at_bid_under30",
        "maker_recent_30to60", "maker_at_bid_30to60",
    ):
        assert field in API and field in UI
    assert "lag_seconds<=30" in API
    assert "lag_seconds>30" in API
    assert "abs(bid_offset_ticks)<=0.5" in API

def test_pair_quotes_never_claim_guaranteed_arbitrage():
    assert "resting_two_bid_sum_below_one" in API
    assert "buying_two_asks_sum_below_one_before_fees" in API
    assert "mean_unfilled_maker_pair_gap" in API
    assert "Un écart de bids ne garantit pas" in UI
    assert "Achats immédiats des deux asks sous 1 $" in UI
