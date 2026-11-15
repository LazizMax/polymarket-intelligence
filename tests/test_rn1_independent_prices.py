"""RN1 historical-price sampling must be causal and report its coverage."""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
SRC=(ROOT/"supabase/functions/pi-rn1-independent-price/index.ts").read_text(encoding="utf8")
UI=(ROOT/"web/index.html").read_text(encoding="utf8")
API=(ROOT/"supabase/functions/pi-dashboard/index.ts").read_text(encoding="utf8")
SCHEMA=(ROOT/"sql/048_rn1_independent_price_private_schema.sql").read_text(encoding="utf8")

def test_uniform_deterministic_token_sampling_no_profit_label():
    assert "MAX_TOKENS_PAGE=8" in SRC
    assert "hash32(String(page)+\"|\"+a)" in SRC
    assert "sort((a,b)=>hash32" in SRC
    assert "sampled_buy_fills" in SRC
    assert "Public price history is NOT historical executable bid/ask" in SRC

def test_future_independent_price_does_not_look_ahead_into_features():
    assert 'u.searchParams.set("startTs",String(Math.min(...ts)-180))' in SRC
    assert 'u.searchParams.set("fidelity","1")' in SRC
    assert "const start=ts+h,end=start+grace" in SRC
    assert "if(points[m].t<start)l=m+1" in SRC
    assert "points[l].t<=end" in SRC
    assert "const position=own<opp?" in SRC
    assert "const out=process(state,rows,roles,hist,chosenSet)" in SRC

def test_role_attribution_and_storage_integrity():
    assert "taker_only:\"true\"" in SRC
    assert 'page.role_status!=="verified"' in SRC
    assert "if(await hash(payload)!==String(page.sha256))" in SRC
    assert 'ON CONFLICT(page_no)' not in SRC or 'on conflict(page_no) do nothing' in SRC
    assert "checkpoint" in SRC and "getRoles(rows,await takersFor(rows),page)" in SRC

def test_dashboard_requires_explicit_coverage():
    assert "independent_price:independentPrices[0]||null" in API
    assert "independent_weekly:independentWeekly" in API
    assert "Prix historiques indépendants : achats Maker" in UI
    assert "Les tokens sont sélectionnés" in UI
    assert "ne constituent pas les anciens" in UI
    assert "Stabilité des prix historiques, par semaine" in UI

def test_private_tables_restrict_user_access():
    assert "ENABLE ROW LEVEL SECURITY" in SCHEMA
    assert "REVOKE ALL ON pi.rn1_independent_price_jobs FROM anon,authenticated" in SCHEMA
    assert "REVOKE ALL ON pi.rn1_independent_price_pages FROM anon,authenticated" in SCHEMA

def test_inverse_token_inclusion_weighting_is_explicit():
    assert "sourceTokenCount" in SRC
    assert "source_tokens) values(" in SRC
    assert "sourceTokenCount]);" in SRC
    assert "independent_adjusted:independentAdjusted" in API
    assert "source_tokens::numeric / nullif(sampled_tokens,0)" in API
    assert "maker_adjusted_markout" in API
    assert "pondération inverse de la probabilité de sélection" in UI
    assert "elle ne corrige PAS" in UI
    assert "source_tokens integer" in SCHEMA

def test_event_level_cluster_uncertainty_is_private_and_causal():
    assert "type EventMoment={n:number;x:number;y:number}" in SRC
    assert "function addEvent(state:State,eventId:string" in SRC
    assert "eventId?\"event:\"+eventId:\"market:\"+market" in SRC
    assert "state.event_start_page=pageNo" in SRC
    assert "addEvent(state,eventId?" in SRC
    assert "function eventEvidence(state:State)" in SRC
    assert "m.y-mu*m.x" in SRC
    assert "1.96*se" in SRC
    assert "event_cluster_evidence=eventEvidence(state)" in SRC
    assert "summary->'event_cluster_evidence' as event_cluster_evidence" in API
    assert "Incertitude regroupée par événement sportif" in UI
    assert "eventN>=30" in UI
    assert "Il exclut les pages précédemment terminées" in UI
