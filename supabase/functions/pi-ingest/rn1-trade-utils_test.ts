import {assertEquals,assertNotEquals} from "jsr:@std/assert@1.0.10";
import {normalizeV2Trade,pageEnvelope,sha256,RN1} from "./rn1-trade-utils.ts";
const base={proxy_wallet:RN1,side:"BUY",token_id:"123456789012345678901234567890",condition_id:"0x"+"a".repeat(64),transaction_hash:"0x"+"b".repeat(64),size:5,price:.4,timestamp:1794703100,outcome_index:1,outcome:"No"};
Deno.test("v2 normalizer preserves token/side/quantity and outcome index",()=>{
 const t=normalizeV2Trade(base)!;
 assertEquals(t.side,"BUY");assertEquals(t.shares,5);assertEquals(t.price,.4);
 assertEquals(t.outcome_index,1);assertEquals(t.observed_notional_usdc,2);
});
Deno.test("rejects other wallet and untraceable fills",()=>{
 assertEquals(normalizeV2Trade({...base,proxy_wallet:"0x"+"1".repeat(40)}),null);
 assertEquals(normalizeV2Trade({...base,transaction_hash:null}),null);
 assertEquals(normalizeV2Trade({...base,size:0}),null);
});
Deno.test("page parser validates opaque cursor contract",()=>{
 assertEquals(pageEnvelope({data:[base],pagination:{has_more:true,next_cursor:"opaque"}})?.nextCursor,"opaque");
 assertEquals(pageEnvelope({data:[base],pagination:{has_more:true,next_cursor:null}}),null);
});
Deno.test("hash of page + ordinal preserves identical records as separate observations",async()=>{
 const page=await sha256(JSON.stringify([base,base]));
 const one=await sha256(page+":0"),two=await sha256(page+":1");
 assertNotEquals(one,two);
});
