import {closedRoi} from "./roi-math.ts";
function check(ok:unknown,msg:string):asserts ok{if(!ok)throw new Error(msg)}
function approx(actual:number|null,expected:number,tol=1e-8){
 check(actual!==null && Math.abs(actual-expected)<=tol,"Expected "+expected+" got "+actual);
}
Deno.test("winner",()=>{const r=closedRoi({status:"CLOSED",total_size:100,avg_price:.4,realized_pnl:10,current_size:0,total_cost_usdc:0});check(r.valid,"winner must be valid");approx(r.cost,40);approx(r.roi,25)});
Deno.test("loser",()=>approx(closedRoi({status:"CLOSED",total_size:100,avg_price:.8,realized_pnl:-50,current_size:0}).roi,-62.5));
Deno.test("zero realized pnl",()=>approx(closedRoi({status:"CLOSED",total_size:100,avg_price:.5,realized_pnl:0,current_size:0}).roi,0));
Deno.test("open not closed",()=>check(!closedRoi({status:"OPEN",total_size:100,avg_price:.5,realized_pnl:8,current_size:40}).valid,"open excluded"));
Deno.test("zero cost not ROI",()=>{const r=closedRoi({status:"CLOSED",total_size:100,avg_price:0,realized_pnl:100,current_size:0});check(!r.valid&&r.roi===null,"missing denominator")});
Deno.test("inventory cannot be treated as exited",()=>check(!closedRoi({status:"CLOSED",total_size:100,avg_price:.5,realized_pnl:10,current_size:20}).valid,"residual"));
Deno.test("missing pnl",()=>check(!closedRoi({status:"CLOSED",total_size:100,avg_price:.5,current_size:0}).valid,"missing"));
Deno.test("ignore percent_realized_pnl and closed remaining cost",()=>{const r=closedRoi({status:"CLOSED",total_size:100,avg_price:.25,realized_pnl:50,current_size:0,total_cost_usdc:0,percent_realized_pnl:-100});approx(r.cost,25);approx(r.roi,200)});
Deno.test("nonfinite",()=>check(!closedRoi({status:"CLOSED",total_size:100,avg_price:.5,realized_pnl:"Infinity",current_size:0}).valid,"infinite"));
Deno.test("observed sample",()=>approx(closedRoi({status:"CLOSED",total_size:584663.2085,avg_price:.2566,realized_pnl:402880.3578,current_size:0}).roi,268.5429012211,1e-6));
