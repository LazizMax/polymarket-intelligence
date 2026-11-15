/** RN1 read-only public quote forensics: CLOB asset IDs, top-of-book and strictly
 * pre-fill joins. A pre-fill sampled book does not reveal RN1's unfilled orders.
 */
export type Target={market_key:string,event_slug:string,title:string,market_type:string,
 assets:[string,string],protocol:string,origin:"rn1_recent"|"sports_control",volume24h:number};
export type Quote={market_key:string,event_slug:string,market_type:string,asset_id:string,
 outcome_index:0|1,origin:string,protocol:string,book_at:number|null,book_hash:string,
 bid:number,ask:number,bid_size:number,ask_size:number,bid_depth3:number,ask_depth3:number,
 tick:number,spread:number,mid:number,book_valid:boolean};
const digits=/^\d{20,90}$/;
const condition=/^0x[0-9a-f]{64}$/;
const str=(x:unknown)=>typeof x==="string"?x:String(x??"");
const num=(x:unknown)=>typeof x==="boolean"||x===null||x===undefined?NaN:Number(x);
const level=(item:any)=>({p:num(item?.price),s:num(item?.size)});
export function targetFromGamma(m:any,origin:"rn1_recent"|"sports_control"):Target|null{
 if(!m||m.closed===true||m.active===false||m.enableOrderBook===false||m.acceptingOrders===false)return null;
 const key=str(m.conditionId).toLowerCase(),kind=str(m.sportsMarketType);
 if(!condition.test(key)||!kind)return null;
 let tokens:any=m.version==="v2"?m.positionIds:m.clobTokenIds;
 if(typeof tokens==="string"){try{tokens=JSON.parse(tokens)}catch{return null}}
 if(!Array.isArray(tokens)||tokens.length!==2||!tokens.every(x=>digits.test(str(x))))return null;
 const event=Array.isArray(m.events)?m.events[0]:null;
 const slug=str(event?.slug||m.slug);
 if(!slug)return null;
 return {market_key:key,event_slug:slug,title:str(m.question||m.title).slice(0,220),
  market_type:kind,assets:[str(tokens[0]),str(tokens[1])],
  protocol:str(m.version||"v1"),origin,volume24h:Number.isFinite(num(m.volume24hr))?num(m.volume24hr):0};
}
export function bookQuotes(books:any[],targets:Target[]):Quote[]{
 if(!Array.isArray(books))throw Error("Invalid CLOB books envelope");
 const mapping=new Map<string,{t:Target,index:0|1}>();
 for(const t of targets){
  mapping.set(t.assets[0],{t,index:0});mapping.set(t.assets[1],{t,index:1});
 }
 const result:Quote[]=[];
 const seen=new Set<string>();
 for(const book of books){
  const id=str(book?.asset_id),mapped=mapping.get(id);
  if(!mapped||seen.has(id)||str(book?.market).toLowerCase()!==mapped.t.market_key)continue;
  seen.add(id);
  const bids:{p:number,s:number}[]=((Array.isArray(book?.bids)?book.bids:[]) as any[]).map(level).filter(x=>x.p>=0&&x.p<=1&&x.s>0);
  const asks:{p:number,s:number}[]=((Array.isArray(book?.asks)?book.asks:[]) as any[]).map(level).filter(x=>x.p>=0&&x.p<=1&&x.s>0);
  // The public API currently sorts worst-to-best in both arrays. Max/min rather
  // than indexing keeps this correct if the provider changes ordering.
  bids.sort((a,b)=>b.p-a.p);
  asks.sort((a,b)=>a.p-b.p);
  const bid=bids[0]?.p??NaN,ask=asks[0]?.p??NaN;
  const tick=num(book?.tick_size);
  const rawTs=num(book?.timestamp);
  const t=Number.isFinite(rawTs)&&rawTs>=946684800000&&rawTs<4102444800000?rawTs:null;
  const ok=Number.isFinite(bid)&&Number.isFinite(ask)&&bid<=ask
   &&bid>=0&&ask<=1&&Number.isFinite(tick)&&tick>0&&tick<=.1;
  result.push({market_key:mapped.t.market_key,event_slug:mapped.t.event_slug,
   market_type:mapped.t.market_type,asset_id:id,outcome_index:mapped.index,
   origin:mapped.t.origin,protocol:mapped.t.protocol,book_at:t,
   book_hash:str(book?.hash).slice(0,128),
   bid:Number.isFinite(bid)?bid:0,ask:Number.isFinite(ask)?ask:1,
   bid_size:bids[0]?.s??0,ask_size:asks[0]?.s??0,
   bid_depth3:bids.slice(0,3).reduce((x,y)=>x+y.s,0),
   ask_depth3:asks.slice(0,3).reduce((x,y)=>x+y.s,0),
   tick:Number.isFinite(tick)?tick:0,
   spread:ok?ask-bid:0,mid:ok?(bid+ask)/2:0,book_valid:ok
  });
 }
 return result;
}
export type BookRun={id:number,finished_at:string,quotes:Quote[]};
export type PublicFill={market_key:string,token_id:string,price:number,shares:number,
 timestamp:number,side:string,transaction_hash:string};
export type Matched=PublicFill&{run_id:number,lag_sec:number,pre_bid:number,pre_ask:number,
 pre_mid:number,pre_spread:number,bid_offset_ticks:number,book_at:number|null,source:string};
export function matchPreTradeBook(fill:PublicFill,runs:BookRun[],minLag=10,maxLag=120):Matched|null{
 if(!condition.test(fill.market_key)||!digits.test(fill.token_id)
  ||!Number.isFinite(fill.timestamp)||!Number.isFinite(fill.price))return null;
 const tradeMs=fill.timestamp*1000;
 let best:{r:BookRun,q:Quote,lag:number}|null=null;
 for(const r of runs){
  const received=Date.parse(r.finished_at);
  const lag=(tradeMs-received)/1000;
  if(!Number.isFinite(lag)||lag<minLag||lag>maxLag)continue;
  for(const q of r.quotes){
   if(q.market_key!==fill.market_key||q.asset_id!==fill.token_id||!q.book_valid)continue;
   if(q.book_at!==null&&q.book_at>received+5000)continue;
   if(!best||lag<best.lag)best={r,q,lag};
  }
 }
 if(!best)return null;
 const {r,q,lag}=best;
 return {...fill,run_id:r.id,lag_sec:lag,pre_bid:q.bid,pre_ask:q.ask,
  pre_mid:q.mid,pre_spread:q.spread,
  bid_offset_ticks:Math.round((fill.price-q.bid)/q.tick*1000)/1000,
  book_at:q.book_at,source:q.origin};
}
export function sportsTakerFee(shares:number,price:number):number{
 if(!Number.isFinite(shares)||!Number.isFinite(price)||shares<0||price<0||price>1)return NaN;
 // Current documented Polymarket sports fee. Fee schedule may change.
 return shares*.05*price*(1-price);
}
export function signature(f:any):string{
 return JSON.stringify([
  str(f?.transaction_hash).toLowerCase(),str(f?.token_id),
  str(f?.side).toUpperCase(),num(f?.price),num(f?.size),
  num(f?.timestamp),str(f?.condition_id).toLowerCase()
 ]);
}
