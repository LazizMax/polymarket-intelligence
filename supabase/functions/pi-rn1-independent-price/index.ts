// Independent historical market-price audit across RN1's archived executions.
// Only public CLOB price history; no orders, private keys or account actions.
// Public price history is NOT historical executable bid/ask and not necessarily
// unaffected by RN1's market impact. Stratified token sample is a research cohort.
import postgres from "npm:postgres@3.4.3";
const dbUrl=Deno.env.get("SUPABASE_DB_URL")||"";
const host=Deno.env.get("SUPABASE_URL")||"",service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
if(!dbUrl||!host||!service)throw Error("Private server configuration missing");
const db=postgres(dbUrl,{max:1,prepare:false,connect_timeout:10});
const JOB="rn1_independent_price_v1",BUCKET="pi-rn1-research-private";
const RN1="0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
const HORIZONS=[60,300,900,1800,3600] as const;
const GRACE=[150,180,180,240,300] as const;
const MAX_TOKENS_PAGE=8;
type Holding={q0:number;q1:number};
type Moment={t:number,p:number};
type Summary={fills:number;sampled_buy_fills:number;roles:Record<string,number>;
 market_price:Record<string,Record<string,{n:number,positive:number,negative:number,flat:number,weighted:number,shares:number,sum:number}>>;
 coverage:{requested:number,ok:number,history_empty:number,history_error:number};
};
type State={hold:Record<string,Holding>;summary:Summary};
const zero=()=>({n:0,positive:0,negative:0,flat:0,weighted:0,shares:0,sum:0});
const fresh=():State=>({hold:{},summary:{fills:0,sampled_buy_fills:0,roles:{maker:0,taker:0,unknown:0},
 market_price:{},coverage:{requested:0,ok:0,history_empty:0,history_error:0}}});
const response=(x:unknown,status=200)=>Response.json(x,{status,headers:{"Cache-Control":"no-store"}});
function bump(x:Record<string,number>,k:string,n=1){x[k]=(x[k]||0)+n}
async function hash(text:string){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("")}
async function allowed(req:Request){const token=req.headers.get("x-pi-scheduler-token")||"";if(!/^[0-9a-f]{64}$/.test(token))return false;
 const rows=await db.unsafe("select 1 from pi.scheduler_auth where single_row_id=1 and token_sha256=$1",[await hash(token)]);return rows.length===1}
async function readStorage(key:string){
 const r=await fetch(host+"/storage/v1/object/"+BUCKET+"/"+key,{headers:{Authorization:"Bearer "+service,apikey:service},signal:AbortSignal.timeout(25000)});
 if(!r.ok||!r.body)throw Error("Private storage read "+r.status);
 return await new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).text();
}
async function writeStorage(key:string,raw:string){
 const bytes=new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
 if(bytes.byteLength>16000000)throw Error("Checkpoint > 16 MB");
 const r=await fetch(host+"/storage/v1/object/"+BUCKET+"/"+key,{method:"POST",headers:{Authorization:"Bearer "+service,apikey:service,"Content-Type":"application/gzip","x-upsert":"true"},body:bytes,signal:AbortSignal.timeout(35000)});
 if(!r.ok)throw Error("Checkpoint upload "+r.status);
}
async function deleteStorage(key:string|null){if(!key)return;try{await fetch(host+"/storage/v1/object/"+BUCKET+"/"+key,{method:"DELETE",headers:{Authorization:"Bearer "+service,apikey:service},signal:AbortSignal.timeout(15000)})}catch(_){}}
const sign=(r:any)=>JSON.stringify([String(r?.transaction_hash??"").toLowerCase(),String(r?.token_id??""),String(r?.side??"").toUpperCase(),Number(r?.price),Number(r?.size),Number(r?.timestamp),String(r?.condition_id??"").toLowerCase()]);
async function api(url:string){
 for(let i=0;i<3;i++){
  const r=await fetch(url,{signal:AbortSignal.timeout(17000),headers:{accept:"application/json"}});
  if((r.status===429||r.status===503)&&i<2){await new Promise(resolve=>setTimeout(resolve,1200*(i+1)));continue}
  if(!r.ok)throw Error("HTTP "+r.status);
  return await r.json();
 }throw Error("Retries exhausted");
}
async function takersFor(rows:any[]){
 const ts=rows.map(r=>Number(r.timestamp));
 if(ts.length===0||ts.some(t=>!Number.isSafeInteger(t)))throw Error("Source timestamp invalid");
 let cursor:string|null=null,results:any[]=[];
 for(let i=0;i<12;i++){
  const u=new URL("https://data-api.polymarket.com/v2/trades");
  for(const [k,v] of Object.entries({user:RN1,start:String(Math.min(...ts)),end:String(Math.max(...ts)),limit:"1000",taker_only:"true"}))u.searchParams.set(k,v);
  if(cursor)u.searchParams.set("cursor",cursor);
  const r=await api(u.toString());
  if(!Array.isArray(r?.data)||r?.data.length>1000||typeof r?.pagination?.has_more!=="boolean")throw Error("Taker source invalid");
  results.push(...r.data);
  if(!r.pagination.has_more)return results;
  const next=r.pagination.next_cursor;if(!next||next===cursor)throw Error("Taker cursor loop");cursor=String(next);
 }
 throw Error("Taker history > 12 pages");
}
function getRoles(rows:any[],tak:any[],page:any){
 const total=new Map<string,number>(),part=new Map<string,number>();
 for(const x of rows){const k=sign(x);total.set(k,(total.get(k)||0)+1)}
 for(const x of tak){const k=sign(x);part.set(k,(part.get(k)||0)+1)}
 const roles=rows.map(r=>{const k=sign(r),n=total.get(k)||0,t=part.get(k)||0;return t===0?"maker":t===n?"taker":"unknown"});
 const makers=roles.filter(x=>x==="maker").length,takers=roles.filter(x=>x==="taker").length,unknown=roles.length-makers-takers;
 if(makers>Number(page.maker_fills)||takers>Number(page.taker_fills)||unknown===0&&(makers!==Number(page.maker_fills)||takers!==Number(page.taker_fills)))
  throw Error("Maker role mismatch source audit");
 return roles;
}
function hash32(key:string){let h=2166136261;for(let i=0;i<key.length;i++){h^=key.charCodeAt(i);h=Math.imul(h,16777619)}return h>>>0}
function selectTokens(rows:any[],page:number){
 const ids=new Set(rows.map(x=>String(x?.token_id??"")).filter(x=>/^[0-9]{20,100}$/.test(x)));
 return [...ids].sort((a,b)=>hash32(String(page)+"|"+a)-hash32(String(page)+"|"+b)||a.localeCompare(b)).slice(0,MAX_TOKENS_PAGE);
}
async function historyFor(token:string,rows:any[]):Promise<{points:Moment[],status:"ok"|"empty"|"error"}>{
 const ts=rows.map(x=>Number(x.timestamp)).filter(Number.isSafeInteger);
 if(!ts.length)return {points:[],status:"error"};
 const u=new URL("https://clob.polymarket.com/prices-history");
 u.searchParams.set("market",token);u.searchParams.set("startTs",String(Math.min(...ts)-180));
 u.searchParams.set("endTs",String(Math.max(...ts)+4500));
 u.searchParams.set("fidelity","1");
 try{
  const raw=await api(u.toString());
  if(!Array.isArray(raw?.history))return {points:[],status:"error"};
  if(raw.history.length>16000)return {points:[],status:"error"};
  const points=raw.history.map((x:any)=>({t:Number(x?.t),p:Number(x?.p)}))
   .filter((x:Moment)=>Number.isSafeInteger(x.t)&&Number.isFinite(x.p)&&x.p>=0&&x.p<=1)
   .sort((a:Moment,b:Moment)=>a.t-b.t);
  return {points,status:points.length?"ok":"empty"};
 }catch(_){return {points:[],status:"error"}}
}
function match(points:Moment[],ts:number,h:number,grace:number):number|null{
 // No pre-trade or look-ahead reference can match. Returns first valid candle
 // at or AFTER requested horizon, within a bounded latency window.
 const start=ts+h,end=start+grace;
 let l=0,r=points.length;
 while(l<r){const m=(l+r)>>>1;if(points[m].t<start)l=m+1;else r=m}
 return l<points.length&&points[l].t<=end?points[l].p:null;
}
function stat(s:Summary,h:number,role:string,position:string,priceMove:number,shares:number){
 const byH=s.market_price[String(h)]||(s.market_price[String(h)]={});
 for(const key of [role+"|all",role+"|"+position]){
  const m=byH[key]||(byH[key]=zero());m.n++;
  if(priceMove>0)m.positive++;else if(priceMove<0)m.negative++;else m.flat++;
  m.weighted+=shares*priceMove;m.shares+=shares;m.sum+=priceMove;
 }
}
function process(state:State,rows:any[],roles:string[],hist:Map<string,{points:Moment[],status:string}>,selected:Set<string>){
 const pageSummary:Summary=fresh().summary;
 const marketSet=new Set<string>(),events=new Set<string>();let minTs=Infinity,maxTs=0;
 for(let i=rows.length-1;i>=0;i--){
  const r=rows[i],market=String(r.condition_id||"").toLowerCase(),token=String(r.token_id||"");
  const at=Number(r.timestamp),q=Number(r.size),p=Number(r.price),o=Number(r.outcome_index),side=String(r.side||"").toUpperCase(),role=roles[i];
  if(!/^0x[0-9a-f]{64}$/.test(market)||String(r.proxy_wallet||"").toLowerCase()!==RN1||
   !(o===0||o===1)||!Number.isSafeInteger(at)||!Number.isFinite(q)||q<=0||
   !Number.isFinite(p)||p<0||p>1||!(side==="BUY"||side==="SELL"))throw Error("Invalid replay row");
  state.summary.fills++;pageSummary.fills++;minTs=Math.min(minTs,at);maxTs=Math.max(maxTs,at);
  const holding=state.hold[market]||(state.hold[market]={q0:0,q1:0});
  const own=o===0?holding.q0:holding.q1,opp=o===0?holding.q1:holding.q0;
  const position=own<opp?"underweight":own>opp?"overweight":"neutral";
  if(side==="BUY"&&selected.has(token)){
   state.summary.sampled_buy_fills++;pageSummary.sampled_buy_fills++;
   bump(state.summary.roles,role);bump(pageSummary.roles,role);
   marketSet.add(market);if(r.event_slug)events.add(String(r.event_slug).slice(0,230));
   for(let j=0;j<HORIZONS.length;j++){
    const price=match(hist.get(token)?.points||[],at,HORIZONS[j],GRACE[j]);
    if(price!==null){
     stat(state.summary,HORIZONS[j],role,position,price-p,q);
     stat(pageSummary,HORIZONS[j],role,position,price-p,q);
    }
   }
  }
  if(side==="BUY"){if(o===0)holding.q0+=q;else holding.q1+=q}
  else {if(o===0)holding.q0=Math.max(0,holding.q0-q);else holding.q1=Math.max(0,holding.q1-q)}
 }
 return {minTs,maxTs,marketSet,events,pageSummary};
}
async function tick(){
 const claimed=await db.unsafe("update pi.rn1_independent_price_jobs set lease_until=now()+interval '110 seconds',updated_at=now() where job_key=$1 and status='running' and (lease_until is null or lease_until<now()) returning next_page,checkpoint_key",[JOB]);
 if(!claimed.length)return {status:"idle_or_leased"};
 const pageNo=Number(claimed[0].next_page);
 try{
  const caps=await db.unsafe("select pg_database_size(current_database()) as bytes");
  if(Number(caps[0].bytes)>298000000){
   await db.unsafe("update pi.rn1_independent_price_jobs set status='paused_quota',lease_until=null,last_error='Shared database safety headroom' where job_key=$1",[JOB]);
   return {status:"paused_quota"};
  }
  const meta=await db.unsafe("select page_no,sha256,row_count,valid_count,role_status,maker_fills,taker_fills,storage_key from pi.rn1_full_archive_pages where stream='trades_all' and page_no=$1",[pageNo]);
  if(!meta.length)throw Error("Archived page missing");
  const page=meta[0];
  if(page.role_status!=="verified"){
   await db.unsafe("update pi.rn1_independent_price_jobs set lease_until=null,last_error='Await verified Maker/Taker page' where job_key=$1",[JOB]);
   return {status:"waiting_role_audit",page:pageNo};
  }
  const payload=await readStorage(String(page.storage_key));
  if(await hash(payload)!==String(page.sha256))throw Error("Immutable source SHA mismatch");
  const rows=JSON.parse(payload)?.source_response?.data;
  if(!Array.isArray(rows)||rows.length!==Number(page.row_count)||rows.length!==Number(page.valid_count))throw Error("Source completeness mismatch");
  const state:State=claimed[0].checkpoint_key?JSON.parse(await readStorage(String(claimed[0].checkpoint_key))):fresh();
  const roles=getRoles(rows,await takersFor(rows),page);
  const chosen=selectTokens(rows,pageNo),chosenSet=new Set(chosen);
  const byToken=new Map<string,any[]>();
  for(const token of chosen)byToken.set(token,rows.filter((r:any)=>String(r.token_id)===token));
  const series=await Promise.all(chosen.map(token=>historyFor(token,byToken.get(token)||[])));
  const hist=new Map(chosen.map((token,i)=>[token,series[i]]));
  const coverage={requested:chosen.length,ok:series.filter(x=>x.status==="ok").length,
    history_empty:series.filter(x=>x.status==="empty").length,history_error:series.filter(x=>x.status==="error").length};
  for(const [k,v] of Object.entries(coverage))bump(state.summary.coverage,k,v);
  const out=process(state,rows,roles,hist,chosenSet);
  const checkpoint="independent-prices-v1/state/page-"+String(pageNo).padStart(8,"0")+"-"+String(page.sha256).slice(0,16)+".json.gz";
  await writeStorage(checkpoint,JSON.stringify(state));
  const matched=Object.fromEntries(HORIZONS.map(h=>[String(h),Number(out.pageSummary.market_price[String(h)]?.["maker|all"]?.n||0)]));
  await db.begin(async tx=>{
   const r=await tx.unsafe("insert into pi.rn1_independent_price_pages(page_no,source_sha256,min_trade_at,max_trade_at,sampled_tokens,sampled_buy_fills,sample_market_count,sample_event_slugs,history_requests,history_success,matched_by_horizon,summary,checkpoint_key) values($1,$2,to_timestamp($3),to_timestamp($4),$5,$6,$7,($8::text)::jsonb,$9,$10,($11::text)::jsonb,($12::text)::jsonb,$13) on conflict(page_no) do nothing returning page_no",
     [pageNo,page.sha256,out.minTs,out.maxTs,chosen.length,out.pageSummary.sampled_buy_fills,out.marketSet.size,
      JSON.stringify([...out.events]),coverage.requested,coverage.ok,JSON.stringify(matched),JSON.stringify(out.pageSummary),checkpoint]);
   if(!r.length)throw Error("Page already processed");
   const advanced=await tx.unsafe("update pi.rn1_independent_price_jobs set next_page=$2::bigint,pages_done=pages_done+1,source_fills=source_fills+$3,sampled_buy_fills=sampled_buy_fills+$4,sampled_maker_fills=sampled_maker_fills+$5,sampled_taker_fills=sampled_taker_fills+$6,sampled_unknown_fills=sampled_unknown_fills+$7,checkpoint_key=$8,summary=($9::text)::jsonb,lease_until=null,last_success_at=now(),status=case when $2::bigint=0 then 'complete' else 'running' end,completed_at=case when $2::bigint=0 then now() else completed_at end,last_error=null,error_attempts=0,updated_at=now() where job_key=$1 and next_page=$10 and status='running' returning next_page",
     [JOB,pageNo-1,rows.length,out.pageSummary.sampled_buy_fills,out.pageSummary.roles.maker||0,out.pageSummary.roles.taker||0,
      out.pageSummary.roles.unknown||0,checkpoint,JSON.stringify(state.summary),pageNo]);
   if(!advanced.length)throw Error("Replay cursor moved concurrently");
  });
  if(claimed[0].checkpoint_key)await deleteStorage(String(claimed[0].checkpoint_key));
  return {status:pageNo===1?"complete":"running",page:pageNo,source_fills:rows.length,
    selected_tokens:chosen.length,sampled_buys:out.pageSummary.sampled_buy_fills,history_ok:coverage.ok,
    maker_15m_references:matched["900"]};
 }catch(error){
  const msg=String(error instanceof Error?error.message:error).slice(0,210);
  await db.unsafe("update pi.rn1_independent_price_jobs set lease_until=null,error_attempts=error_attempts+1,status=case when error_attempts+1>=5 then 'paused_error' else status end,last_error=$2,updated_at=now() where job_key=$1",[JOB,msg]);
  return {status:"error",page:pageNo,error:msg};
 }
}
Deno.serve(async req=>{
 if(req.method!=="POST")return response({error:"not_found"},404);
 if(!await allowed(req))return response({error:"unauthorized"},403);
 let data:any={};try{data=await req.json()}catch(_){}
 if(data.action!=="independent_price_tick")return response({error:"invalid_action"},400);
 const pages=Math.min(3,Math.max(1,Number.isInteger(data.pages)?data.pages:1));
 const results:any[]=[];
 for(let i=0;i<pages;i++){
  const current=await tick();results.push(current);
  if(current.status!=="running")break;
 }
 return response({status:results.at(-1)?.status||"idle",pages_completed:results.filter(x=>x.page).length,results});
});
