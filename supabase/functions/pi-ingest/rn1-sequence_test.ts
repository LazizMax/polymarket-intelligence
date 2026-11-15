import {assertEquals,assert} from "jsr:@std/assert@1.0.10";
import {classifyExecutedFlowPage, type SourceMarketState} from "./rn1-sequence.ts";
const mk=(market_key:string,sec:number,index:number,shares:number,price=.5)=>({
 market_key,reported_at:new Date(1794700000_000+sec*1000).toISOString(),
 side:"BUY",outcome_index:index,shares,price,observed_notional_usdc:shares*price
});
Deno.test("oldest-first reconstruction despite latest-first feed",()=>{
 const states=new Map<string,SourceMarketState>();
 const {stats}=classifyExecutedFlowPage([
  mk("a",120,0,2), mk("a",60,1,4),mk("a",0,0,10)
 ],states);
 assertEquals(stats.fills,3);
 assertEquals(stats.first_market_fills,1);
 assertEquals(stats.first_opposite_fills,1);
 assertEquals(stats.comparable_buy_fills,2);
 assertEquals(stats.underweight_buys,1);
 assertEquals(stats.overweight_buys,1);
 assertEquals(stats.reduces_gap_buys,1);
 assertEquals(stats.increases_gap_buys,1);
 assertEquals(stats.lag_buckets[1],1);
 assertEquals(states.get("a")?.buy0_shares,12);
 assertEquals(states.get("a")?.buy1_shares,4);
});
Deno.test("state crossing page boundaries is preserved",()=>{
 const states=new Map<string,SourceMarketState>();
 classifyExecutedFlowPage([mk("b",0,0,10)],states);
 const {stats}=classifyExecutedFlowPage([mk("b",600,1,3)],states);
 assertEquals(stats.first_market_fills,0);
 assertEquals(stats.first_opposite_fills,1);
 assertEquals(stats.reduces_gap_buys,1);
 assertEquals(states.get("b")?.buy1_shares,3);
});
Deno.test("price-ladder repeated execution is observed, not claimed as placed order",()=>{
 const states=new Map<string,SourceMarketState>();
 const {stats}=classifyExecutedFlowPage([
  mk("c",100,0,10,.52),mk("c",50,0,10,.50),mk("c",0,0,10,.50)
 ],states);
 assertEquals(stats.same_outcome_same_price_300s,1);
 assertEquals(stats.same_outcome_price_up_300s,1);
 assertEquals(stats.repeat_same_market_60s,2);
 assertEquals(stats.buy_fills,3);
});
Deno.test("negative observed inventory proxy excluded from buy imbalance inference",()=>{
 const states=new Map<string,SourceMarketState>();
 const buy=mk("d",100,1,3);
 const sell={...mk("d",0,0,10),side:"SELL"};
 const {stats}=classifyExecutedFlowPage([buy,sell],states);
 assertEquals(stats.sell_fills,1);
 assertEquals(stats.comparable_buy_fills,0);
 assertEquals(states.get("d")?.sell0_shares,10);
 assertEquals(states.get("d")?.buy1_shares,3);
});
Deno.test("invalid outcome does not update state",()=>{
 const states=new Map<string,SourceMarketState>();
 const {stats}=classifyExecutedFlowPage([{...mk("d",0,5,10),outcome_index:null}],states);
 assertEquals(stats.fills,1);assertEquals(stats.valid_fills,0);assertEquals(states.size,0);
});
