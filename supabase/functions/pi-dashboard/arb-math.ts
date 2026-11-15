// Pure arithmetic for a read-only paired YES/NO orderbook scanner.
// A quote is NOT a fill, and provisioning is NOT the exchange's actual fee calculation.
export type Level = {price: string | number; size: string | number};
export type FillQuote = {shares:number; cost:number; average:number; worst:number};
export function walkAsks(levels: unknown, requested: number):FillQuote|null {
 if(!Array.isArray(levels)||!Number.isFinite(requested)||requested<=0)return null;
 const sorted: {price:number;size:number}[]=[];
 for(const entry of levels){
  if(!entry||typeof entry!=="object")continue;
  const p=Number((entry as Level).price),n=Number((entry as Level).size);
  if(!Number.isFinite(p)||p<=0||p>=1||!Number.isFinite(n)||n<=0)continue;
  sorted.push({price:p,size:n});
 }
 sorted.sort((a,b)=>a.price-b.price);
 let remaining=requested,cost=0,worst=0;
 for(const level of sorted){
  const take=Math.min(remaining,level.size);
  if(take<=0)continue;
  cost+=take*level.price;remaining-=take;worst=level.price;
  if(remaining<=1e-8)break;
 }
 if(remaining>1e-8)return null;
 return {shares:requested,cost,average:cost/requested,worst};
}
export function quotePair(yesLevels:unknown,noLevels:unknown,shares:number,reservePct:number){
 if(!Number.isFinite(reservePct)||reservePct<0||reservePct>20)return null;
 const yes=walkAsks(yesLevels,shares),no=walkAsks(noLevels,shares);
 if(!yes||!no)return null;
 const cost=yes.cost+no.cost,gross=shares-cost;
 const provisionalCosts=cost*reservePct/100,netIndicative=gross-provisionalCosts;
 return {shares,yes_avg:yes.average,no_avg:no.average,yes_worst:yes.worst,no_worst:no.worst,
  yes_cost:yes.cost,no_cost:no.cost,paired_cost:cost,gross_edge_usdc:gross,
  gross_roi_pct:100*gross/cost,fee_reserve_usdc:provisionalCosts,
  indicative_net_usdc:netIndicative,indicative_roi_pct:100*netIndicative/(cost+provisionalCosts),
  profitable_after_reserve:netIndicative>0};
}
