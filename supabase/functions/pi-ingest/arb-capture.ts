// Bounded, unauthenticated market-data capture. Invoked only by the scheduler-authenticated pi-ingest route.
// This module NEVER submits orders. It captures both entry asks and hypothetical liquidation bids.
const GAMMA="https://gamma-api.polymarket.com/markets";
const BOOKS="https://clob.polymarket.com/books";
type Level={price:string|number;size:string|number};
export function weightedBook(levels:unknown,shares:number,side:"asks"|"bids"):number|null{
 if(!Array.isArray(levels)||!Number.isFinite(shares)||shares<=0)return null;
 const prices:{p:number;s:number}[]=[];
 for(const raw of levels){
  if(!raw||typeof raw!=="object")continue;
  const l=raw as Level,p=Number(l.price),s=Number(l.size);
  if(p>0&&p<1&&s>0&&Number.isFinite(p)&&Number.isFinite(s))prices.push({p,s});
 }
 prices.sort((a,b)=>side==="asks"?a.p-b.p:b.p-a.p);
 let remain=shares,cost=0;
 for(const l of prices){const take=Math.min(remain,l.s);cost+=take*l.p;remain-=take;if(remain<=1e-8)break;}
 return remain>1e-8?null:cost/shares;
}
export function bestPrice(levels:unknown,side:"asks"|"bids"):number|null{
 if(!Array.isArray(levels))return null;
 const prices=levels.map((x:any)=>Number(x?.price)).filter(x=>Number.isFinite(x)&&x>0&&x<1);
 return prices.length?(side==="asks"?Math.min(...prices):Math.max(...prices)):null;
}
function asArray(x:unknown):unknown[]{
 if(Array.isArray(x))return x;
 if(typeof x==="string"){try{const a=JSON.parse(x);return Array.isArray(a)?a:[]}catch{return []}}
 return [];
}
export async function captureTemporalBooks(maxMarkets=12,quoteShares=50){
 if(maxMarkets<1||maxMarkets>15||quoteShares<1||quoteShares>500)throw Error("Invalid collector bounds");
 const url=new URL(GAMMA);
 for(const [k,v] of Object.entries({active:"true",closed:"false",limit:"40",order:"volume24hr",ascending:"false"}))url.searchParams.set(k,v);
 const gamma=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(10000),cache:"no-store"});
 if(!gamma.ok)throw Error("Gamma temporal "+gamma.status);
 const source=await gamma.json();
 if(!Array.isArray(source))throw Error("Bad Gamma market list");
 const selected:any[]=[];
 for(const m of source){
  if(selected.length>=maxMarkets)break;
  if(!m||m.closed===true||m.active===false||m.enableOrderBook===false)continue;
  const outcomes=asArray(m.outcomes).map(x=>String(x).trim().toLowerCase());
  const tokens=asArray(m.clobTokenIds).map(x=>String(x));
  const condition=String(m.conditionId||"");
  if(outcomes.length!==2||outcomes[0]!=="yes"||outcomes[1]!=="no"||tokens.length!==2
    ||tokens[0]===tokens[1]||!tokens.every(x=>/^\d{20,90}$/.test(x))||!condition)continue;
  selected.push({market_key:condition,slug:String(m.slug||"").slice(0,180),
   event_slug:String(Array.isArray(m.events)?m.events[0]?.slug||"":"" ).slice(0,180),
   question:String(m.question||"").slice(0,220),tokens});
 }
 if(!selected.length)return {markets_seen:source.length,selected:0,rows:[]};
 const params=selected.flatMap(m=>m.tokens.map((token_id:string)=>({token_id})));
 const response=await fetch(BOOKS,{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},
  body:JSON.stringify(params),signal:AbortSignal.timeout(11000),cache:"no-store"});
 if(!response.ok)throw Error("CLOB temporal "+response.status);
 const data=await response.json();
 if(!Array.isArray(data))throw Error("Bad CLOB books payload");
 const map=new Map<string,any>();
 for(const x of data)if(typeof x?.asset_id==="string")map.set(x.asset_id,x);
 const batch=crypto.randomUUID(),at=new Date().toISOString(),rows=[];
 for(const m of selected){
  const y=map.get(m.tokens[0]),n=map.get(m.tokens[1]);
  if(!y||!n)continue;
  const minSize=Math.max(Number(y.min_order_size||0),Number(n.min_order_size||0));
  const fillable=Number.isFinite(minSize)&&quoteShares>=minSize;
  rows.push({batch_id:batch,observed_at:at,market_key:m.market_key,market_slug:m.slug,event_slug:m.event_slug||null,question:m.question,
   yes_token_id:m.tokens[0],no_token_id:m.tokens[1],quote_shares:quoteShares,
   yes_buy_avg:fillable?weightedBook(y.asks,quoteShares,"asks"):null,
   no_buy_avg:fillable?weightedBook(n.asks,quoteShares,"asks"):null,
   yes_sell_avg:fillable?weightedBook(y.bids,quoteShares,"bids"):null,
   no_sell_avg:fillable?weightedBook(n.bids,quoteShares,"bids"):null,
   yes_best_bid:bestPrice(y.bids,"bids"),no_best_bid:bestPrice(n.bids,"bids"),
   yes_best_ask:bestPrice(y.asks,"asks"),no_best_ask:bestPrice(n.asks,"asks")});
 }
 if(!rows.length)throw Error("CLOB returned no matching token books");
 return {markets_seen:source.length,selected:selected.length,rows,observed_at:at,batch_id:batch};
}
