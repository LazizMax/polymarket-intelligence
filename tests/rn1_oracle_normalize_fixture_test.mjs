import assert from "node:assert/strict";
import {normalizePayload} from "../supabase/functions/pi-rn1-odds/normalize.ts";

// Entirely synthetic. Validate contract matching, receipt timestamps,
// pregame gating, vig removal and rejection of unattributed outcomes.
const observed=new Date("2026-11-16T01:46:01.000Z");
const raw={success:true,data:[{
 event_id:"game_12345",league:"NBA",
 home_team:"Sacramento Kings",away_team:"Oklahoma City Thunder",
 start_time:"2026-11-16T02:00:00Z",
 books:[{book:"draftkings",market:"h2h",updated_at:"2026-11-16T01:45:30Z",
  outcomes:[{name:"Oklahoma City Thunder",price:-620},{name:"Sacramento Kings",price:458}]},
 {book:"fanduel",market:"spreads",updated_at:"2026-11-16T01:45:30Z",
  outcomes:[{name:"Oklahoma City Thunder",price:-110},{name:"Sacramento Kings",price:-110}]}]
}]};
const rows=normalizePayload(raw,observed);
assert.equal(rows.length,1);
assert.equal(rows[0].event_slug,"nba-okc-sac-2026-11-15");
assert.equal(rows[0].first_seen_at,observed.toISOString());
assert.equal(rows[0].book_updated_at,"2026-11-16T01:45:30.000Z");
assert.equal(rows[0].bookmaker,"draftkings");
assert(Math.abs(rows[0].away_fair_probability+rows[0].home_fair_probability-1)<1e-10);
assert(rows[0].away_fair_probability>0.8&&rows[0].away_fair_probability<0.9);
assert.equal(normalizePayload(raw,new Date("2026-11-16T02:01:00Z")).length,0);
assert.equal(normalizePayload({...raw,success:false},observed).length,0);
const malformed=structuredClone(raw);
malformed.data[0].books[0].outcomes[0].name="Random Unmatched Team";
assert.equal(normalizePayload(malformed,observed).length,0);
const futureTimestamp=structuredClone(raw);
futureTimestamp.data[0].books[0].updated_at="2026-11-17T01:45:30Z";
assert.equal(normalizePayload(futureTimestamp,observed).length,0);
console.log("RN1 oracle normalizer: pregame NY/US timezone, exact team matching, bookmaker vig and causal timestamp checks OK");
