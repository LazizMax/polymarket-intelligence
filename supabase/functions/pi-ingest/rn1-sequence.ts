/** A bounded, chronological behavioural fingerprint from PUBLIC EXECUTED trades.
 *
 * The signed buy/sell shares are NOT actual wallet inventory: transfers, merges,
 * redemptions, missing earlier history and rejected limit orders are unobserved.
 * Source pages arrive newest first, so process page_no descending and reverse rows.
 * The sequence within a timestamp is source-defined but not an exchange queue log.
 */
export type SourceMarketState={
 market_key:string,
 buy0_shares:number,buy1_shares:number,sell0_shares:number,sell1_shares:number,
 fills0:number,fills1:number,
 first_at:string,first_side:number,first_opposite_at:string|null,
 last_at:string,last_at0:string|null,last_at1:string|null,
 last_price0:number|null,last_price1:number|null
};
export const emptyStats=()=>({
 fills:0,valid_fills:0,buy_fills:0,sell_fills:0,notional_usdc:0,
 first_market_fills:0,first_opposite_fills:0,
 before_both_seen:0,
 comparable_buy_fills:0,underweight_buys:0,overweight_buys:0,neutral_buys:0,
 reduces_gap_buys:0,increases_gap_buys:0,unchanged_gap_buys:0,
 overcorrects_buys:0,underweight_usdc:0,overweight_usdc:0,
 repeat_same_market_60s:0,repeat_same_market_300s:0,
 repeat_same_outcome_300s:0,same_outcome_same_price_300s:0,
 same_outcome_price_up_300s:0,same_outcome_price_down_300s:0,
 price_counts:[0,0,0,0,0],price_usdc:[0,0,0,0,0],
 size_counts:[0,0,0,0,0],size_usdc:[0,0,0,0,0],
 lag_buckets:[0,0,0,0,0],
 imbalance_buckets:[
  {total:0,underweight:0,overweight:0,neutral:0},
  {total:0,underweight:0,overweight:0,neutral:0},
  {total:0,underweight:0,overweight:0,neutral:0}
 ]
});
const finite=(n:unknown)=>typeof n==="number"&&Number.isFinite(n);
const toMs=(value:string|null)=>value?Date.parse(value):NaN;
export function classifyExecutedFlowPage(
 rows:ReadonlyArray<{
  market_key:string;reported_at:string;side:string;outcome_index:number|null;
  shares:number;price:number;observed_notional_usdc:number;
 }>,
 states:Map<string,SourceMarketState>
){
 const out=emptyStats();const changed=new Set<string>();
 // Source API returns latest-first rows: reversing also preserves deterministic
 // original ordering of ties, though exact within-second exchange order is unknown.
 for(let i=rows.length-1;i>=0;i--){
  const t=rows[i];out.fills++;
  const index=t.outcome_index;
  if((index!==0&&index!==1)||!(t.side==="BUY"||t.side==="SELL")
   ||!finite(t.shares)||t.shares<=0||!finite(t.price)||t.price<0||t.price>1
   ||!Number.isFinite(Date.parse(t.reported_at)))continue;
  out.valid_fills++;
  const price=t.price,size=t.shares,usd=t.observed_notional_usdc,when=t.reported_at;
  const ms=Date.parse(when);const market=t.market_key;
  let state=states.get(market);
  if(!state){
   out.first_market_fills++;
   state={market_key:market,buy0_shares:0,buy1_shares:0,sell0_shares:0,sell1_shares:0,
    fills0:0,fills1:0,first_at:when,first_side:index,first_opposite_at:null,
    last_at:when,last_at0:null,last_at1:null,last_price0:null,last_price1:null};
   states.set(market,state);
  }
  changed.add(market);
  const prev0=state.buy0_shares-state.sell0_shares;
  const prev1=state.buy1_shares-state.sell1_shares;
  const beforeGap=Math.abs(prev0-prev1);
  const previouslyBoth=state.fills0>0&&state.fills1>0;
  if(previouslyBoth)out.before_both_seen++;
  if(!state.first_opposite_at&&index!==state.first_side){
   state.first_opposite_at=when;out.first_opposite_fills++;
   const lag=(ms-Date.parse(state.first_at))/1000;
   const b=lag<60?0:lag<300?1:lag<900?2:lag<3600?3:4;
   out.lag_buckets[b]++;
  }
  const deltaMarket=ms-toMs(state.last_at);
  if(state.fills0+state.fills1>0&&deltaMarket>=0&&deltaMarket<=60000)out.repeat_same_market_60s++;
  if(state.fills0+state.fills1>0&&deltaMarket>=0&&deltaMarket<=300000)out.repeat_same_market_300s++;
  const sameAt=index===0?state.last_at0:state.last_at1;
  const samePrice=index===0?state.last_price0:state.last_price1;
  const sameDelta=ms-toMs(sameAt);
  if(sameAt!==null&&sameDelta>=0&&sameDelta<=300000){
   out.repeat_same_outcome_300s++;
   if(samePrice!==null){
    if(Math.abs(price-samePrice)<=1e-8)out.same_outcome_same_price_300s++;
    else if(price>samePrice)out.same_outcome_price_up_300s++;
    else out.same_outcome_price_down_300s++;
   }
  }
  const pb=Math.min(4,Math.max(0,Math.floor(price*5)));
  const sb=usd<10?0:usd<50?1:usd<200?2:usd<1000?3:4;
  out.price_counts[pb]++;out.price_usdc[pb]+=usd;
  out.size_counts[sb]++;out.size_usdc[sb]+=usd;
  out.notional_usdc+=usd;
  if(t.side==="BUY"){
   out.buy_fills++;
   if(prev0>=0&&prev1>=0&&prev0+prev1>0){
    out.comparable_buy_fills++;
    const after0=prev0+(index===0?size:0);
    const after1=prev1+(index===1?size:0);
    const afterGap=Math.abs(after0-after1);
    if(afterGap<beforeGap-1e-8)out.reduces_gap_buys++;
    else if(afterGap>beforeGap+1e-8)out.increases_gap_buys++;
    else out.unchanged_gap_buys++;
    if((index===0&&prev0<prev1)||(index===1&&prev1<prev0)){
     out.underweight_buys++;out.underweight_usdc+=usd;
     if(afterGap>beforeGap+1e-8)out.overcorrects_buys++;
    }else if((index===0&&prev0>prev1)||(index===1&&prev1>prev0)){
     out.overweight_buys++;out.overweight_usdc+=usd;
    }else out.neutral_buys++;
    const skew=beforeGap/(prev0+prev1);
    const b=skew<.1?0:skew<.5?1:2;
    out.imbalance_buckets[b].total++;
    if((index===0&&prev0<prev1)||(index===1&&prev1<prev0))
     out.imbalance_buckets[b].underweight++;
    else if((index===0&&prev0>prev1)||(index===1&&prev1>prev0))
     out.imbalance_buckets[b].overweight++;
    else out.imbalance_buckets[b].neutral++;
   }
   if(index===0)state.buy0_shares+=size;else state.buy1_shares+=size;
  }else{
   out.sell_fills++;
   if(index===0)state.sell0_shares+=size;else state.sell1_shares+=size;
  }
  if(index===0){
   state.fills0++;state.last_at0=when;state.last_price0=price;
  }else{
   state.fills1++;state.last_at1=when;state.last_price1=price;
  }
  state.last_at=when;
 }
 return {stats:out,changed:[...changed].map(m=>states.get(m)!)};
}
