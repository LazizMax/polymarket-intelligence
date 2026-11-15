/** One CLOSED outcome position, not an individual BUY/SELL fill.
 * The v2 CLOSED total_cost_usdc is zero (remaining holding basis).
 * Estimate original entry principal as lifetime shares × weighted average
 * entry price; excludes unknown entry/exit fees and transfer effects.
 */
export type ClosedRoi = {cost:number|null;pnl:number|null;roi:number|null;valid:boolean;reason:string|null};
function finite(x:unknown):number|null{
 if(x===null||x===undefined||x===""||typeof x==="boolean")return null;
 const n=Number(x);return Number.isFinite(n)?n:null;
}
export function closedRoi(p:any):ClosedRoi{
 const empty={cost:null,pnl:null,roi:null,valid:false,reason:"incomplete_position"} as ClosedRoi;
 if(!p||p.status!=="CLOSED")return {...empty,reason:"not_closed"};
 const shares=finite(p.total_size),price=finite(p.avg_price),pnl=finite(p.realized_pnl),left=finite(p.current_size);
 if(shares===null||price===null||pnl===null||left===null)return empty;
 if(shares<=0||price<=0||price>1.000001)return {...empty,reason:"no_valid_lifetime_entry"};
 if(Math.abs(left)>Math.max(1e-5,shares*1e-8))return {...empty,reason:"residual_shares"};
 const cost=shares*price;
 if(!Number.isFinite(cost)||cost<0.000001||cost>1e18)return {...empty,reason:"invalid_entry_cost"};
 const roi=100*pnl/cost;
 if(!Number.isFinite(roi)||Math.abs(roi)>1e12)return {...empty,reason:"invalid_roi"};
 return {cost,pnl,roi,valid:true,reason:null};
}
