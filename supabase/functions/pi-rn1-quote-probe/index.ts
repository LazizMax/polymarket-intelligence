// Public RN1 market research: read-only data feed + before-fill CLOB snapshots.
// No trading keys, no order placement, no claims of full wallet or executable alpha.
import postgres from "npm:postgres@3.4.3";
import {targetFromGamma,bookQuotes,matchPreTradeBook,sportsTakerFee,signature,
 type Target,type Quote,type BookRun,type PublicFill} from "./quote-utils.ts";

const RN1="0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
const BUCKET="pi-rn1-research-private";
const walletRE=/^0x[0-9a-f]{40}$/,conditionRE=/^0x[0-9a-f]{64}$/;
const dbUrl=Deno.env.get("SUPABASE_DB_URL");
if(!dbUrl)throw Error("Supabase database connection is missing");
const db=postgres(dbUrl,{max:1,prepare:false,connect_timeout:10});
const json=(data:unknown,code=200)=>Response.json(data,{status:code,headers:{"cache-control":"no-store"}});
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function stamp(){return new Date().toISOString()}
async function hash(t:string):Promise<string>{
 const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(t));
 return [...new Uint8Array(d)].map(v=>v.toString(16).padStart(2,"0")).join("");
}
async function schedulerAllowed(req:Request){
 const token=req.headers.get("x-pi-scheduler-token")||"";
 if(!/^[0-9a-f]{64}$/.test(token))return false;
 const h=await hash(token);
 const rows=await db.unsafe("select 1 from pi.scheduler_auth where single_row_id=1 and token_sha256=$1",[h]);
 return rows.length===1;
}
async function fetchJSON(url:string,init?:RequestInit){
 for(let attempt=0;attempt<3;attempt++){
  const response=await fetch(url,{...init,signal:AbortSignal.timeout(18000)});
  if((response.status===429||response.status===503)&&attempt<2){
   await sleep((attempt+1)*1800);continue;
  }
  if(!response.ok)throw Error("Public data "+new URL(url).hostname+" returned "+response.status);
  return await response.json();
 }
 throw Error("Public data retry budget exhausted");
}
async function gzip(s:string){
 const stream=new Blob([s]).stream().pipeThrough(new CompressionStream("gzip"));
 return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function storeArchive(objectKey:string,payload:Uint8Array){
 const key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
 const url=Deno.env.get("SUPABASE_URL")||"";
 if(!key||!/^https:\/\/[^/]+\.supabase\.co$/.test(url))throw Error("Private Storage unavailable");
 const response=await fetch(url+"/storage/v1/object/"+BUCKET+"/"+objectKey,{
  method:"POST",headers:{"apikey":key,"Authorization":"Bearer "+key,
  "Content-Type":"application/gzip","x-upsert":"true","cache-control":"3600"},
  body:payload as BodyInit,signal:AbortSignal.timeout(25000)
 });
 if(!response.ok)throw Error("Private quote archive upload "+response.status);
}
function rawTrades(body:any){
 if(!body||!Array.isArray(body.data)||!body.pagination||body.data.length>1000)
  throw Error("Public RN1 trade feed changed response shape");
 return body.data as any[];
}
function getFreshMarkets(rows:any[],timeSec:number){
 const aggregate=new Map<string,number>();
 for(const t of rows){
  const k=String(t?.condition_id??"").toLowerCase();
  const ts=Number(t?.timestamp);
  if(!conditionRE.test(k)||!Number.isFinite(ts)||ts<timeSec-3600||ts>timeSec+10)continue;
  const shares=Number(t?.size),price=Number(t?.price);
  aggregate.set(k,(aggregate.get(k)||0)+
   (Number.isFinite(shares)&&Number.isFinite(price)?Math.max(0,shares*price):0));
 }
 return [...aggregate.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12).map(x=>x[0]);
}
async function selectMarkets(fullTrades:any[]):Promise<Target[]>{
 const nowSec=Math.floor(Date.now()/1000);
 const recent=getFreshMarkets(fullTrades,nowSec);
 let preferred:Target[]=[];
 if(recent.length){
  const url=new URL("https://gamma-api.polymarket.com/markets");
  url.searchParams.set("closed","any");url.searchParams.set("limit","30");
  for(const k of recent)url.searchParams.append("condition_ids",k);
  const data=await fetchJSON(url.toString(),{headers:{accept:"application/json"}});
  if(!Array.isArray(data))throw Error("Gamma condition-list is invalid");
  preferred=data.map((m:any)=>targetFromGamma(m,"rn1_recent")).filter((x:Target|null):x is Target=>x!==null);
 }
 // This control set is preselected WITHOUT RN1 fills, so never claim that the
 // control markets represent RN1's actual candidate/order universe.
 const fallback=await fetchJSON(
  "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&order=volume24hr&ascending=false",
  {headers:{accept:"application/json"}});
 if(!Array.isArray(fallback))throw Error("Gamma live market-list is invalid");
 const controls=fallback.map((m:any)=>targetFromGamma(m,"sports_control"))
  .filter((x:Target|null):x is Target=>x!==null)
  .sort((a:Target,b:Target)=>b.volume24h-a.volume24h);
 const targets:Target[]=[],seen=new Set<string>(),events=new Set<string>();
 for(const x of [...preferred.slice(0,5),...controls]){
  if(targets.length>=8)break;
  if(seen.has(x.market_key))continue;
  // For controls avoid redundant correlated markets from the same game.
  if(x.origin==="sports_control"&&events.has(x.event_slug))continue;
  targets.push(x);seen.add(x.market_key);events.add(x.event_slug);
 }
 return targets;
}
function isValidTrade(t:any):t is any{
 return walletRE.test(String(t?.proxy_wallet??"").toLowerCase())
  &&String(t.proxy_wallet).toLowerCase()===RN1
  &&conditionRE.test(String(t?.condition_id??"").toLowerCase())
  &&/^\d{20,90}$/.test(String(t?.token_id??""))
  &&(t?.side==="BUY"||t?.side==="SELL")
  &&Number.isFinite(Number(t?.size))&&Number(t.size)>0
  &&Number.isFinite(Number(t?.price))&&Number(t.price)>=0&&Number(t.price)<=1
  &&Number.isSafeInteger(Number(t?.timestamp));
}
async function collectMatches(full:any[],validQuotes:Quote[],now:Date){
 // This run's own books must not be joined to earlier trades.
 const hist=await db.unsafe(`
 select id,received_at::text as finished_at,quotes from pi.rn1_quote_probe_runs
 where received_at > now()-interval '5 minutes'
 order by received_at desc limit 12`);
 const history:BookRun[]=hist.map((r:any)=>({id:Number(r.id),
  finished_at:new Date(r.finished_at).toISOString(),quotes:r.quotes as Quote[]}));
 if(history.length===0)return {matched:0};
 const lastTen=full.filter(t=>isValidTrade(t)&&Number(t.timestamp)>Date.now()/1000-420);
 if(!lastTen.length)return {matched:0};
 let takers:any[]=[];
 try{
  takers=rawTrades(await fetchJSON(
   "https://data-api.polymarket.com/v2/trades?user="+RN1+
   "&start=1&limit=1000&taker_only=true",
   {headers:{accept:"application/json"}}));
 }catch(e){console.error("taker feed unavailable; role unknown",String(e));}
 const allCounts=new Map<string,number>(),takerCounts=new Map<string,number>();
 for(const t of full){const k=signature(t);allCounts.set(k,(allCounts.get(k)||0)+1)}
 for(const t of takers){const k=signature(t);takerCounts.set(k,(takerCounts.get(k)||0)+1)}
 const oldestAll=Math.min(...full.map(t=>Number(t?.timestamp)).filter(Number.isFinite));
 const oldestTaker=Math.min(...takers.map(t=>Number(t?.timestamp)).filter(Number.isFinite));
 // Some filled rows are identical under the public signature; mixed-role
 // duplicates must be UNKNOWN, not assigned arbitrarily.
 const verifiedTakerCoverage=Number.isFinite(oldestTaker)&&Number.isFinite(oldestAll)
  &&oldestTaker<=oldestAll-10;
 const seen=new Map<string,number>(),matched:any[]=[];
 for(const raw of lastTen){
  const identity=signature(raw);
  const ordinal=(seen.get(identity)||0)+1;seen.set(identity,ordinal);
  const f:PublicFill={market_key:String(raw.condition_id).toLowerCase(),
   token_id:String(raw.token_id),price:Number(raw.price),shares:Number(raw.size),
   timestamp:Number(raw.timestamp),side:String(raw.side),
   transaction_hash:String(raw.transaction_hash)};
  const book=matchPreTradeBook(f,history,10,120);
  if(!book)continue;
  const nAll=allCounts.get(identity)||1,nTaker=takerCounts.get(identity)||0;
  const role=verifiedTakerCoverage?
   (nTaker===nAll?"taker_verified":nTaker===0?"maker_inferred":"unknown"):"unknown";
  const fee=role==="taker_verified"?sportsTakerFee(f.shares,f.price):
   role==="maker_inferred"?0:null;
  const fingerprint=await hash(identity+"::occurrence="+ordinal);
  matched.push({fingerprint,run_id:book.run_id,market_key:f.market_key,
   token_id:f.token_id,trade_at:new Date(f.timestamp*1000).toISOString(),
   side:f.side,role,fill_price:f.price,shares:f.shares,
   lag_seconds:book.lag_sec,pre_bid:book.pre_bid,pre_ask:book.pre_ask,
   pre_mid:book.pre_mid,pre_spread:book.pre_spread,
   bid_offset_ticks:book.bid_offset_ticks,
   book_timestamp:book.book_at===null?null:new Date(book.book_at).toISOString(),
   source_group:book.source,sports_taker_fee_estimate:fee});
 }
 if(!matched.length)return {matched:0};
 const inserted=await db.unsafe(`
 insert into pi.rn1_quote_probe_fills(
 fingerprint,run_id,market_key,token_id,trade_at,side,role,fill_price,shares,
 lag_seconds,pre_bid,pre_ask,pre_mid,pre_spread,bid_offset_ticks,book_timestamp,
 source_group,sports_taker_fee_estimate)
 select x.fingerprint,x.run_id,x.market_key,x.token_id,x.trade_at,x.side,x.role,
  x.fill_price,x.shares,x.lag_seconds,x.pre_bid,x.pre_ask,x.pre_mid,
  x.pre_spread,x.bid_offset_ticks,x.book_timestamp,x.source_group,
  x.sports_taker_fee_estimate
 from jsonb_to_recordset(($1::text)::jsonb) as x(
  fingerprint text,run_id bigint,market_key text,token_id text,trade_at timestamptz,
  side text,role text,fill_price numeric,shares numeric,lag_seconds numeric,
  pre_bid numeric,pre_ask numeric,pre_mid numeric,pre_spread numeric,
  bid_offset_ticks numeric,book_timestamp timestamptz,source_group text,
  sports_taker_fee_estimate numeric)
 on conflict(fingerprint) do nothing returning fingerprint`,[JSON.stringify(matched)]);
 return {matched:inserted.length};
}
async function tick(){
 const claim=await db.unsafe(`
 update pi.rn1_quote_probe_state set lease_until=now()+interval '110 seconds',
 updated_at=now() where singleton=true and status='collecting'
 and (lease_until is null or lease_until<now())
 returning max_db_bytes,max_archive_bytes,archived_gzip_bytes`);
 if(!claim.length)return {status:"idle_or_paused"};
 const slot=new Date(Math.floor(Date.now()/60000)*60000).toISOString();
 const output={status:"collecting",markets:0,books:0,matched:0,slot};
 try{
  const caps=await db.unsafe(`select pg_database_size(current_database())::bigint as db_bytes,
   (select coalesce(sum(raw_gzip_bytes),0)::bigint from pi.rn1_full_streams) as research_archive_bytes`);
  if(Number(caps[0].db_bytes)>Number(claim[0].max_db_bytes)
    ||Number(caps[0].research_archive_bytes)+Number(claim[0].archived_gzip_bytes)>Number(claim[0].max_archive_bytes)){
   await db.unsafe(`update pi.rn1_quote_probe_state set status='paused_quota',
    lease_until=null,last_error='Quote research paused before shared storage/database safety budgets'
    where singleton=true`);
   return {...output,status:"paused_quota"};
  }
  const old=await db.unsafe("select id from pi.rn1_quote_probe_runs where slot_at=$1",[slot]);
  if(old.length){
   await db.unsafe("update pi.rn1_quote_probe_state set lease_until=null where singleton=true");
   return {...output,status:"duplicate_slot"};
  }
  const walletRows=rawTrades(await fetchJSON(
   "https://data-api.polymarket.com/v2/trades?user="+RN1+
   "&start=1&limit=1000&taker_only=false",{headers:{accept:"application/json"}}));
  const targets=await selectMarkets(walletRows);
  if(!targets.length)throw Error("No currently tradable sports markets; cannot measure books");
  const requestStarted=stamp();
  const books=await fetchJSON("https://clob.polymarket.com/books",{
   method:"POST",headers:{"content-type":"application/json",accept:"application/json"},
   body:JSON.stringify(targets.flatMap(t=>t.assets.map(asset_id=>({token_id:asset_id}))))});
  const receivedAt=stamp();
  const quotes=bookQuotes(books,targets);
  if(quotes.length<2)throw Error("CLOB did not return two valid books");
  const raw=JSON.stringify({source:"https://clob.polymarket.com/books",
   request_started_at:requestStarted,received_at:receivedAt,targets,books});
  const digest=await hash(raw);
  const payload=await gzip(raw);
  if(payload.length>20_000_000)throw Error("Quote archive exceeded maximum object size");
  if(Number(caps[0].research_archive_bytes)+Number(claim[0].archived_gzip_bytes)+payload.length
    >Number(claim[0].max_archive_bytes))throw Error("Private quote archive budget exhausted");
  const key="quotes/"+slot.slice(0,10)+"/"+slot.replace(/[^0-9]/g,"")+"-"+digest.slice(0,14)+".json.gz";
  await storeArchive(key,payload);
  const inserted=await db.unsafe(`
   insert into pi.rn1_quote_probe_runs(
    slot_at,requested_at,received_at,market_count,book_count,rn1_market_count,
    archive_key,raw_sha256,compressed_bytes,quotes)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9,($10::text)::jsonb)
   on conflict(slot_at) do nothing returning id`,
   [slot,requestStarted,receivedAt,targets.length,quotes.length,
   targets.filter(t=>t.origin==="rn1_recent").length,
   key,digest,payload.length,JSON.stringify(quotes)]);
  if(!inserted.length)throw Error("Concurrent quote probe minute already archived");
  // Current quotes are NEVER used as historical evidence for earlier trades.
  const match=await collectMatches(walletRows,quotes,new Date(receivedAt));
  await db.unsafe(`update pi.rn1_quote_probe_state set
   completed_runs=completed_runs+1,matched_fills=matched_fills+$1,
   archived_gzip_bytes=archived_gzip_bytes+$2,
   last_success_at=now(),last_error=null,error_streak=0,lease_until=null,updated_at=now()
   where singleton=true`,[match.matched,payload.length]);
  output.markets=targets.length;output.books=quotes.length;output.matched=match.matched;
  return {...output,rn1_targets:targets.filter(t=>t.origin==="rn1_recent").length,
   quote_age_sec:0,archive_bytes:payload.length};
 }catch(e){
  const message=e instanceof Error?e.message.slice(0,190):"quote sampling failure";
  console.error("rn1_quote_probe",message);
  await db.unsafe(`update pi.rn1_quote_probe_state set
   error_streak=error_streak+1,status=case when error_streak>=4 then 'paused_error' else status end,
   last_error=$1,lease_until=null,updated_at=now() where singleton=true`,[message]);
  return {...output,status:"error",error:message};
 }
}
Deno.serve(async req=>{
 if(req.method!=="POST")return json({error:"Method not allowed"},405);
 if(Number(req.headers.get("content-length")||0)>2000)return json({error:"Payload too large"},413);
 try{
  const body=await req.json();
  if(body?.action!=="quote_probe_scheduled")return json({error:"Unsupported action"},400);
  if(!await schedulerAllowed(req))return json({error:"Forbidden"},403);
  return json(await tick());
 }catch(e){console.error("quote_probe_request",String(e));return json({error:"Research probe unavailable"},500);}
});
