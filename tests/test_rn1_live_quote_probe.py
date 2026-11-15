"""Strict RN1 CLOB forensics constraints: no post-fill quotes or fabricated alpha."""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
PROBE=(ROOT/"supabase/functions/pi-rn1-quote-probe/index.ts").read_text()
UTILS=(ROOT/"supabase/functions/pi-rn1-quote-probe/quote-utils.ts").read_text()
API=(ROOT/"supabase/functions/pi-dashboard/index.ts").read_text()
WEB=(ROOT/"web/index.html").read_text()
SQL=(ROOT/"sql/035_rn1_live_quote_probe.sql").read_text()

def test_explicit_full_wallet_and_true_both_sides():
    assert "taker_only=false" in PROBE
    assert 'url.searchParams.append("condition_ids",k)' in PROBE
    assert "https://clob.polymarket.com/books" in PROBE
    assert "m.version===\"v2\"?m.positionIds:m.clobTokenIds" in UTILS
    assert "volume24h" in PROBE

def test_true_causal_snapshots_and_no_live_trading():
    assert "tradeMs-received" in UTILS
    assert "lag<minLag||lag>maxLag" in UTILS
    assert "matchPreTradeBook(f,history,10,120)" in PROBE
    assert "quote.book_at" not in PROBE
    assert "new CompressionStream(\"gzip\")" in PROBE
    assert "SUPABASE_SERVICE_ROLE_KEY" in PROBE
    assert "async function schedulerAllowed(req:Request)" in PROBE
    assert "status='paused_quota'" in PROBE

def test_closed_market_filter_and_both_outcomes():
    assert "m.closed===true" in UTILS
    assert "bookQuotes(books,targets)" in PROBE
    assert "bid<=ask" in UTILS
    assert "bids.sort((a,b)=>b.p-a.p)" in UTILS
    assert "asks.sort((a,b)=>a.p-b.p)" in UTILS

def test_fees_rls_and_ui_truthful():
    assert "shares*.05*price*(1-price)" in UTILS
    assert "revoke all on pi.rn1_quote_probe_state" in SQL
    assert "alter table pi.rn1_quote_probe_fills enable row level security;" in SQL
    assert 'api("rn1_quote_forensics")' in WEB
    assert "Ce n'est pas le PnL net du wallet" in WEB
    assert "Aucun prix limite exact ni aucune rentabilité future" in WEB
    assert 'if(body?.action==="rn1_quote_forensics")' in API
    assert "best_bid_mae_ticks" in API
