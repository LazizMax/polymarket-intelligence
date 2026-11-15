// Prospective-style, time-ordered counterfactual replay of observed orderbook snapshots.
// Crucial: no actual trades happened; no maker queue/fill probability is inferred here.
export type TemporalSample = {
 market_key:string; market_slug:string; event_slug?:string|null; question:string; observed_at:string;
 yes_token_id:string; no_token_id:string; quote_shares:number | string;
 yes_buy_avg:number|string|null;no_buy_avg:number|string|null;
 yes_sell_avg:number|string|null;no_sell_avg:number|string|null;
};
export type TemporalConfig = {entryCeiling:number;feeReservePct:number;minNetRoiPct:number;maxHoldMinutes:number};
type Position = {side:"YES"|"NO";at:number;cost:number;entryPrice:number};
function validPrice(x:unknown):number|null{
 if(x===null||x===undefined||x==="")return null;
 const n=Number(x);return Number.isFinite(n)&&n>0&&n<1?n:null;
}
const trunc=(x:string,n:number)=>String(x||"").slice(0,n);
export function replayTemporal(raw:TemporalSample[],cfg:TemporalConfig){
 if(!Number.isFinite(cfg.entryCeiling)||cfg.entryCeiling<=0||cfg.entryCeiling>=1)throw Error("Invalid entry ceiling");
 if(!Number.isFinite(cfg.feeReservePct)||cfg.feeReservePct<0||cfg.feeReservePct>20)throw Error("Invalid reserve");
 if(!Number.isFinite(cfg.minNetRoiPct)||cfg.minNetRoiPct<0||cfg.minNetRoiPct>20)throw Error("Invalid min ROI");
 if(!Number.isFinite(cfg.maxHoldMinutes)||cfg.maxHoldMinutes<1||cfg.maxHoldMinutes>10080)throw Error("Invalid max hold");
 const markets=new Map<string,TemporalSample[]>();
 for(const sample of raw){
  if(!sample.market_key||!Number.isFinite(Date.parse(sample.observed_at)))continue;
  const a=markets.get(sample.market_key)||[];a.push(sample);markets.set(sample.market_key,a);
 }
 const results:any[]=[];
 let totalPairs=0,totalStops=0,unpricedStops=0,lockedNet=0,stoppedNet=0,openMarkets=0;
 for(const [market,items] of markets){
  items.sort((a,b)=>Date.parse(a.observed_at)-Date.parse(b.observed_at));
  const first=items[0],qty=Number(first.quote_shares);
  if(!Number.isFinite(qty)||qty<=0)continue;
  let pos:Position|null=null,pairs=0,stops=0,stuck=0,pairedNet=0,stopNet=0,maxExposure=0;
  let lastQuote:any=null,lastDate=0,latest:any=null;
  const tokenSig=first.yes_token_id+"-"+first.no_token_id;
  for(const sample of items){
   if(sample.yes_token_id+"-"+sample.no_token_id!==tokenSig||Number(sample.quote_shares)!==qty)continue;
   const when=Date.parse(sample.observed_at);
   if(lastDate && when<=lastDate)continue; // one observation per instant, no same-timestamp pairing
   lastDate=when;latest=sample;
   const yes=validPrice(sample.yes_buy_avg),no=validPrice(sample.no_buy_avg);
   const yesSell=validPrice(sample.yes_sell_avg),noSell=validPrice(sample.no_sell_avg);
   lastQuote={yes,no,yesSell,noSell};
   if(pos){
    const opposite=pos.side==="YES"?no:yes;
    const minutes=(when-pos.at)/60000;
    // Hedge only at a STRICTLY LATER recorded snapshot, never using future minimum prices.
    if(opposite!==null){
      const nominal=pos.cost+qty*opposite;
      const estimatedFees=nominal*cfg.feeReservePct/100;
      const net=qty-nominal-estimatedFees;
      const netRoi=100*net/(nominal+estimatedFees);
      if(minutes>0&&minutes<=cfg.maxHoldMinutes&&netRoi>=cfg.minNetRoiPct){
       pairedNet+=net;pairs++;pos=null;continue;
      }
    }
    if(minutes>=cfg.maxHoldMinutes){
      const sellPrice=pos.side==="YES"?yesSell:noSell;
      if(sellPrice!==null){
        const proceeds=qty*sellPrice;
        const net=proceeds-pos.cost-(proceeds+pos.cost)*cfg.feeReservePct/100;
        stopNet+=net;stops++;pos=null;continue;
      }
      // No bid for our full quantity: we cannot claim a liquidation or start another position.
      stuck++;
    }
    continue;
   }
   const chosen= yes!==null&&yes<=cfg.entryCeiling&&(no===null||yes<=no||no>cfg.entryCeiling)
     ?{side:"YES" as const,price:yes}:no!==null&&no<=cfg.entryCeiling?{side:"NO" as const,price:no}:null;
   if(chosen){
     pos={side:chosen.side,at:when,cost:chosen.price*qty,entryPrice:chosen.price};
     maxExposure=Math.max(maxExposure,pos.cost);
   }
  }
  const lastAt=lastDate?new Date(lastDate).toISOString():null;
  const lastBuyYes=validPrice(latest?.yes_buy_avg),lastBuyNo=validPrice(latest?.no_buy_avg);
  const lastPair=lastBuyYes!==null&&lastBuyNo!==null?lastBuyYes+lastBuyNo:null;
  let open:any=null;
  if(pos){
   const px=pos.side==="YES"?lastQuote?.yesSell:lastQuote?.noSell;
   const estimated_exit_net=px!==null&&px!==undefined
     ? qty*px-pos.cost-(qty*px+pos.cost)*cfg.feeReservePct/100:null;
   open={side:pos.side,entry_at:new Date(pos.at).toISOString(),entry_price:pos.entryPrice,
     cost:pos.cost,age_minutes:Math.max(0,(lastDate-pos.at)/60000),
     exit_at_bid_estimated_net:estimated_exit_net,worst_case_loss_bound:-pos.cost};
   openMarkets++;
  }
  totalPairs+=pairs;totalStops+=stops;unpricedStops+=stuck;lockedNet+=pairedNet;stoppedNet+=stopNet;
  const confirmedEventSlug=items.map(x=>x.event_slug).filter(x=>typeof x==="string"&&x.length>0).at(-1)||null;
  results.push({market_key:market,slug:trunc(first.market_slug,140),event_slug:confirmedEventSlug,question:trunc(first.question,220),
    snapshots:items.length,first_at:first.observed_at,last_at:lastAt,latest_yes_buy:lastBuyYes,
    latest_no_buy:lastBuyNo,latest_pair_cost:lastPair,pairs,stops,stuck_snapshots:stuck,
    paired_net:pairedNet,stop_net:stopNet,closed_net_scenario:pairedNet+stopNet,
    max_exposure:maxExposure,open});
 }
 results.sort((a,b)=>(b.pairs+b.stops)-(a.pairs+a.stops)||b.snapshots-a.snapshots);
 return {summary:{markets:results.length,samples:raw.length,pairs:totalPairs,stops:totalStops,
  unpriced_snapshots:unpricedStops,open_markets:openMarkets,
  paired_net_scenario:lockedNet,stopped_net_scenario:stoppedNet,
  closed_net_scenario:lockedNet+stoppedNet},
  rows:results};
}
