import {assert,assertEquals,assertAlmostEquals} from "jsr:@std/assert@1.0.10";
import {targetFromGamma,bookQuotes,matchPreTradeBook,sportsTakerFee,signature} from "./quote-utils.ts";
const key="0x"+"a".repeat(64),target={market_key:key,event_slug:"nba-test-2026",title:"Team vs Team",
market_type:"moneyline",assets:["1".repeat(70),"2".repeat(70)] as [string,string],protocol:"v1",origin:"sports_control" as const,volume24h:1000};
Deno.test("v1/v2 choose correct outcome asset identifiers",()=>{
 const m={conditionId:key,events:[{slug:"nba-test-2026"}],sportsMarketType:"moneyline",
 version:"v1",clobTokenIds:JSON.stringify(target.assets),positionIds:["3".repeat(70),"4".repeat(70)]};
 assertEquals(targetFromGamma(m,"sports_control")?.assets,target.assets);
 m.version="v2";
 assertEquals(targetFromGamma(m,"sports_control")?.assets,m.positionIds);
 assertEquals(targetFromGamma({...m,closed:true},"sports_control"),null);
});
Deno.test("best bid is maximum and best ask minimum, no reliance on array index",()=>{
 const books=[{market:key,asset_id:target.assets[0],timestamp:"1794760000000",tick_size:"0.01",
  bids:[{price:"0.42",size:"2"},{price:"0.48",size:"4"},{price:"0.45",size:"9"}],
  asks:[{price:"0.58",size:"5"},{price:"0.53",size:"6"}],hash:"abc"}];
 const q=bookQuotes(books,[target]);assertEquals(q.length,1);
 assertEquals(q[0].bid,.48);assertEquals(q[0].ask,.53);assertAlmostEquals(q[0].mid,.505);
 assertAlmostEquals(q[0].bid_depth3,15);assertEquals(q[0].book_valid,true);
});
Deno.test("never use post-fill or stale quotes to infer maker offset",()=>{
 const q=bookQuotes([{market:key,asset_id:target.assets[0],timestamp:"1794760000000",tick_size:"0.01",
 bids:[{price:".48",size:"10"}],asks:[{price:".52",size:"10"}]}],[target])[0];
 const t=1794760050;
 const f={market_key:key,token_id:target.assets[0],timestamp:t,price:.48,shares:10,
  side:"BUY",transaction_hash:"0x"+"f".repeat(64)};
 assertEquals(matchPreTradeBook(f,[{id:2,finished_at:new Date((t+1)*1000).toISOString(),quotes:[q]}]),null);
 assertEquals(matchPreTradeBook(f,[{id:1,finished_at:new Date((t-150)*1000).toISOString(),quotes:[q]}]),null);
 const r=matchPreTradeBook(f,[{id:3,finished_at:new Date((t-20)*1000).toISOString(),quotes:[q]}]);
 assertEquals(r?.lag_sec,20);assertEquals(r?.bid_offset_ticks,0);
});
Deno.test("sports fees nonzero for taker and zero maker (caller handles role)",()=>{
 assertAlmostEquals(sportsTakerFee(100,.5),1.25);
 assertAlmostEquals(sportsTakerFee(100,.2),.8);
});
Deno.test("multiset signature varies by price token and size",()=>{
 const a={transaction_hash:"0xabc",token_id:"123",price:.5,size:10,side:"BUY",timestamp:1794760050,condition_id:key};
 assert(signature(a)!==signature({...a,size:20}));
});
