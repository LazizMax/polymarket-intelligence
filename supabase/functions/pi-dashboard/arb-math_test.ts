import {assertEquals,assertAlmostEquals} from "jsr:@std/assert@1.0.10";
import {walkAsks,quotePair} from "./arb-math.ts";
Deno.test("walk asks uses the cheapest levels and respects depth",()=>{
 const a=walkAsks([{price:"0.49",size:"20"},{price:"0.47",size:"10"}],15);
 assertAlmostEquals(a!.cost,10*0.47+5*0.49,1e-9);
 assertEquals(walkAsks([{price:"0.50",size:"2"}],10),null);
});
Deno.test("paired buy has identical payout regardless of outcome after both fills",()=>{
 const x=quotePair([{price:0.47,size:100}],[{price:0.49,size:100}],100,0);
 assertAlmostEquals(x!.paired_cost,96,1e-8);
 assertAlmostEquals(x!.gross_edge_usdc,4,1e-8);
 assertAlmostEquals(x!.gross_roi_pct,100*4/96,1e-8);
});
Deno.test("fee reserve is a scenario, not an official exchange fee",()=>{
 const x=quotePair([{price:0.47,size:100}],[{price:0.49,size:100}],100,5);
 assertAlmostEquals(x!.fee_reserve_usdc,4.8,1e-8);
 assertAlmostEquals(x!.indicative_net_usdc,-0.8,1e-8);
 assertEquals(x!.profitable_after_reserve,false);
});
Deno.test("rejects missing liquidity and invalid values",()=>{
 assertEquals(quotePair([{price:.4,size:2}],[{price:.5,size:10}],10,0),null);
 assertEquals(quotePair([{price:1,size:20}],[{price:.3,size:10}],10,0),null);
 assertEquals(quotePair([{price:.4,size:20}],[{price:.3,size:20}],10,-1),null);
 assertEquals(walkAsks([],20),null);
});
