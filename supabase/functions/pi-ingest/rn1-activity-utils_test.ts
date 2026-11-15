import {assertEquals,assertNotEquals} from "jsr:@std/assert@1.0.10";
import {RN1,normalizeActivity,envelopeActivity,sha256Activity} from "./rn1-activity-utils.ts";
const example={proxy_wallet:RN1,type:"REDEEM",size:3220,usdc_size:3220,price:0,timestamp:1794709039,
 condition_id:"0x"+"a".repeat(64),token_id:"123456789012345678901234567890",transaction_hash:"0x"+"b".repeat(64),
 outcome:"Over",outcome_index:0,title:"Test",event_slug:"game-test"};
Deno.test("REDEEM payout is not classified as profit",()=>{
 const e=normalizeActivity(example)!;
 assertEquals(e.kind,"REDEEM");assertEquals(e.reported_usdc_size,3220);
 assertEquals(e.amount_usdc,null);assertEquals(e.amount_classification,"unknown");
});
Deno.test("No invented tx hash/market on sparse rewards",()=>{
 const x=normalizeActivity({...example,type:"MAKER_REBATE",condition_id:"",transaction_hash:"",usdc_size:.01})!;
 assertEquals(x.kind,"MAKER_REBATE");assertEquals(x.market_key,null);assertEquals(x.tx_hash,null);
});
Deno.test("Filter different wallet or malformed events",()=>{
 assertEquals(normalizeActivity({...example,proxy_wallet:"0x"+"c".repeat(40)}),null);
 assertEquals(normalizeActivity({...example,type:""}),null);
});
Deno.test("API cursor is opaque",()=>{
 assertEquals(envelopeActivity({data:[example],pagination:{has_more:true,next_cursor:"abc"}})?.nextCursor,"abc");
 assertEquals(envelopeActivity({data:[example],pagination:{has_more:true,next_cursor:null}}),null);
});
Deno.test("same hash can legitimately appear in distinct activity source rows",async()=>{
 const a=await sha256Activity("page:0"),b=await sha256Activity("page:1");
 assertNotEquals(a,b);
});
