import {assertEquals} from "jsr:@std/assert@1.0.10";
import {matchMakerTaker} from "./rn1-maker-match.ts";
const base={transaction_hash:"0xabc",token_id:"123",side:"BUY",price:.47,size:10,
 timestamp:1794710000,condition_id:"0xdef"};
Deno.test("role inference matches exact taker subset and maker remainder",()=>{
 const a=matchMakerTaker([base,{...base,price:.48},{...base,side:"SELL"}],[base]);
 assertEquals(a,{maker:2,taker:1,unmatchedTaker:0,all:3});
});
Deno.test("deduplicate by entire fill multiset, never just transaction hash",()=>{
 const a=matchMakerTaker([base,base,{...base,price:.49}],[base,base,base]);
 assertEquals(a,{maker:1,taker:2,unmatchedTaker:1,all:3});
});
Deno.test("zero taker rows indicate maker-only page in this API comparison",()=>{
 assertEquals(matchMakerTaker([base],[]).maker,1);
});
