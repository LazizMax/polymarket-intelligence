import {assertEquals,assertAlmostEquals} from "jsr:@std/assert@1.0.10";
import {weightedBook,bestPrice} from "./arb-capture.ts";
Deno.test("best ask/bid independent of returned book ordering",()=>{
 assertEquals(bestPrice([{price:".51"},{price:".48"}],"asks"),.48);
 assertEquals(bestPrice([{price:".51"},{price:".48"}],"bids"),.51);
});
Deno.test("bids are consumed from high price to low for exit liquidity",()=>{
 assertAlmostEquals(weightedBook([{price:.43,size:8},{price:.45,size:2}],10,"bids")!,.434);
 assertAlmostEquals(weightedBook([{price:.45,size:2},{price:.43,size:8}],10,"bids")!,.434);
});
Deno.test("if full size is not available, no optimistic quote is reported",()=>{
 assertEquals(weightedBook([{price:.9,size:3}],10,"asks"),null);
 assertEquals(weightedBook([{price:.4,size:3}],10,"bids"),null);
});
