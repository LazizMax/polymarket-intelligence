import {assertEquals,assertAlmostEquals,assertThrows} from "jsr:@std/assert@1.0.10";
import {replayTemporal, type TemporalSample} from "./arb-temporal.ts";
const c={entryCeiling:.49,feeReservePct:0,minNetRoiPct:.5,maxHoldMinutes:90};
function row(minutes:number,yes:number|null,no:number|null,yBid:number|null=null,nBid:number|null=null):TemporalSample{
 return {market_key:"0xabc",market_slug:"test",question:"Test",yes_token_id:"y",no_token_id:"n",
  quote_shares:50,observed_at:new Date(Date.UTC(2026,0,1,0,minutes)).toISOString(),
  yes_buy_avg:yes,no_buy_avg:no,yes_sell_avg:yBid,no_sell_avg:nBid};
}
Deno.test("cannot hedge at the same observation (no non-causal paired return)",()=>{
 const a=replayTemporal([row(0,.47,.49)],c);
 assertEquals(a.summary.pairs,0);assertEquals(a.summary.open_markets,1);
});
Deno.test("later cheaper opposite side completes hypothetical pair",()=>{
 const a=replayTemporal([row(0,.47,.55),row(20,.56,.49)],c);
 assertEquals(a.summary.pairs,1);assertAlmostEquals(a.summary.paired_net_scenario,50*(1-.47-.49));
});
Deno.test("stop loss is included, no cherry-picked pair returns",()=>{
 const a=replayTemporal([row(0,.47,.55),row(120,.62,.60,.40,.38)],c);
 assertEquals(a.summary.stops,1);assertAlmostEquals(a.summary.stopped_net_scenario,50*(.40-.47));
});
Deno.test("missing liquidation depth remains open, never treated as a zero PnL",()=>{
 const a=replayTemporal([row(0,.47,.55),row(120,.62,.60)],c);
 assertEquals(a.summary.stops,0);assertEquals(a.summary.open_markets,1);
 assertEquals(a.rows[0].open.exit_at_bid_estimated_net,null);
 assertEquals(a.rows[0].open.worst_case_loss_bound,-23.5);
});
Deno.test("provision can eliminate a previously attractive pair",()=>{
 const a=replayTemporal([row(0,.47,.55),row(20,.56,.49)],
  {...c,feeReservePct:5});
 assertEquals(a.summary.pairs,0);assertEquals(a.summary.open_markets,1);
});
Deno.test("reject invalid thresholds",()=>{
 assertThrows(()=>replayTemporal([],{...c,maxHoldMinutes:0}));
});

Deno.test("event navigation uses the event slug, not a different market slug",()=>{
 const a=replayTemporal([
  {...row(0,.47,.55),market_slug:"will-player-x-win-finals",event_slug:"worlds-2026-winner"},
  {...row(20,.56,.49),market_slug:"will-player-x-win-finals",event_slug:"worlds-2026-winner"}
 ],c);
 assertEquals(a.rows[0].slug,"will-player-x-win-finals");
 assertEquals(a.rows[0].event_slug,"worlds-2026-winner");
});
