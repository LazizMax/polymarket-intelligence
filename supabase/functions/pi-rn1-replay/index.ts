// Private read-only full-history RN1 replay. Reconstructs EXECUTED-FLOW inventory,
// not wallet holdings. Future prices are RN1's OWN subsequent fills, NOT external
// independent market midpoints or a reliable adverse-selection estimate.
// Snapshot state stays in a private gzip Storage bucket; SQL stores tiny counters.
import postgres from "npm:postgres@3.4.3";
const dbUrl=Deno.env.get("SUPABASE_DB_URL");
if(!dbUrl)throw Error("SUPABASE_DB_URL is required");
const db=postgres(dbUrl,{max:1,prepare:false,connect_timeout:10});
const BUCKET="pi-rn1-research-private",JOB="rn1_full_chronology_v1";
const RN1="0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
const HOST=Deno.env.get("SUPABASE_URL")||"",SERVICE=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
const HORIZONS=[60,300,900,1800,3600] as const;
const GRACE=[120,300,600,900,1800] as const;
type Holding={q0:number;q1:number;c0:number;c1:number};
type Waiting={t:number;p:number;q:number;role:string;position:string;done:number};
type Metric={n:number;positive:number;negative:number;flat:number;sum:number;shares:number;weighted:number};
type State={market:Record<string,Holding>;pending:Record<string,Waiting[]>;totals:any};
const blank=():State=>({market:{},pending:{},totals:{fills:0,role:{maker:0,taker:0,unknown:0},inventory:{},pair:{},forward:{},invalid:0}});
const metric=():Metric=>({n:0,positive:0,negative:0,flat:0,sum:0,shares:0,weighted:0});
function bump(t:any,name:string,amount=1){t[name]=(Number(t[name])||0)+amount}
function group(t:any,key:string,field:string,amount=1){const d=t[key]||(t[key]={});bump(d,field,amount)}
const num=(x:any)=>x===null||x===undefined?NaN:Number(x);
function sign(raw:any){return JSON.stringify([String(raw?.transaction_hash??"").toLowerCase(),String(raw?.token_id??""),String(raw?.side??"").toUpperCase(),Number(raw?.price),Number(raw?.size),Number(raw?.timestamp),String(raw?.condition_id??"").toLowerCase()])}
async function sha(input:string){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(input));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("")}
function json(payload:unknown,status=200){return Response.json(payload,{status,headers:{"Cache-Control":"no-store"}})}
async function authorized(req:Request){const token=req.headers.get("x-pi-scheduler-token")||"";if(!/^[0-9a-f]{64}$/.test(token))return false;const h=await sha(token);const r=await db.unsafe("select 1 from pi.scheduler_auth where single_row_id=1 and token_sha256=$1",[h]);return r.length===1}
async function fetchPublic(url:string){for(let i=0;i<3;i++){const r=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(16000)});if((r.status===429||r.status===503)&&i<2){await new Promise(resolve=>setTimeout(resolve,1200*(i+1)));continue}if(!r.ok)throw Error("Data API "+r.status);return await r.json()}throw Error("Source retry exhausted")}
async function takerWindow(raw:any[]){
 const times=raw.map(x=>num(x.timestamp)).filter(Number.isFinite);
 if(times.length!==raw.length)throw Error("Missing source timestamps");
 const from=Math.min(...times),to=Math.max(...times);
 let cursor:string|null=null,all:any[]=[];
 for(let page=0;page<12;page++){
  const u=new URL("https://data-api.polymarket.com/v2/trades");
  u.searchParams.set("user",RN1);u.searchParams.set("start",String(from));u.searchParams.set("end",String(to));
  u.searchParams.set("limit","1000");u.searchParams.set("taker_only","true");
  if(cursor)u.searchParams.set("cursor",cursor);
  const p=await fetchPublic(u.toString());
  if(!Array.isArray(p?.data)||typeof p?.pagination?.has_more!=="boolean"||p.data.length>1000)throw Error("Invalid taker pagination");
  all.push(...p.data);
  if(!p.pagination.has_more)return all;
  const next=p.pagination.next_cursor;
  if(!next||next===cursor)throw Error("Taker source cursor did not advance");
  cursor=String(next);
 }
 throw Error("Taker window exceeds 12 pages: refuse maker attribution");
}
function assignRoles(raw:any[],taker:any[],expected:any):string[]{
 const all=new Map<string,number>(),seen=new Map<string,number>();
 for(const f of raw){const k=sign(f);all.set(k,(all.get(k)||0)+1)}
 for(const f of taker){const k=sign(f);seen.set(k,(seen.get(k)||0)+1)}
 const roles=raw.map(f=>{const k=sign(f),n=all.get(k)||0,c=seen.get(k)||0;return c===0?"maker":c===n?"taker":"unknown"});
 const counts={maker:roles.filter(x=>x==="maker").length,taker:roles.filter(x=>x==="taker").length,unknown:roles.filter(x=>x==="unknown").length};
 // The independent earlier full-page audit acts as a cross-check.
 if(counts.unknown===0&&(counts.maker!==Number(expected.maker_fills)||counts.taker!==Number(expected.taker_fills)))
  throw Error("Per-fill maker/taker differs from verified source-page totals");
 if(counts.maker>Number(expected.maker_fills)||counts.taker>Number(expected.taker_fills))
  throw Error("Per-fill role exceeds audited source totals");
 return roles;
}
async function readObject(key:string):Promise<string>{
 if(!HOST||!SERVICE)throw Error("Private Storage credentials unavailable");
 const url=HOST+"/storage/v1/object/"+BUCKET+"/"+key;
 const r=await fetch(url,{headers:{Authorization:"Bearer "+SERVICE,apikey:SERVICE},signal:AbortSignal.timeout(25000)});
 if(!r.ok||!r.body)throw Error("Private snapshot/source HTTP "+r.status);
 return await new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).text();
}
async function writeObject(key:string,payload:string):Promise<number>{
 if(!HOST||!SERVICE)throw Error("Private Storage credentials unavailable");
 const b=new Blob([payload]);const stream=b.stream().pipeThrough(new CompressionStream("gzip"));
 const gz=new Uint8Array(await new Response(stream).arrayBuffer());
 if(gz.byteLength>16000000)throw Error("Replay checkpoint exceeds 16MB compressed safety cap");
 const r=await fetch(HOST+"/storage/v1/object/"+BUCKET+"/"+key,{
  method:"POST",headers:{Authorization:"Bearer "+SERVICE,apikey:SERVICE,"Content-Type":"application/gzip","x-upsert":"true"},
  body:gz,signal:AbortSignal.timeout(35000)
 });if(!r.ok)throw Error("Private checkpoint upload HTTP "+r.status+" "+(await r.text()).slice(0,80));
 return gz.byteLength;
}
async function deleteObject(key:string){if(!key)return;try{await fetch(HOST+"/storage/v1/object/"+BUCKET+"/"+key,{method:"DELETE",headers:{Authorization:"Bearer "+SERVICE,apikey:SERVICE},signal:AbortSignal.timeout(15000)})}catch(_){/* stale checkpoint harmless; never delete sources */}}
function addForward(state:State,w:Waiting,h:number,delta:number){
 for(const key of [w.role+"|all",w.role+"|"+w.position]){
  const bucket=state.totals.forward[h]||(state.totals.forward[h]={});
  const m:Metric=bucket[key]||(bucket[key]=metric());
  m.n++;if(delta>0)m.positive++;else if(delta<0)m.negative++;else m.flat++;
  m.sum+=delta;m.shares+=w.q;m.weighted+=w.q*delta;
 }
}
function observeFuture(state:State,token:string,price:number,at:number){
 const waiting=state.pending[token];if(!waiting)return;
 const still:Waiting[]=[];
 for(const w of waiting){
  for(let i=0;i<HORIZONS.length;i++){
   if(w.done&(1<<i))continue;
   const lower=w.t+HORIZONS[i],upper=lower+GRACE[i];
   if(at>=lower&&at<=upper){addForward(state,w,HORIZONS[i],price-w.p);w.done|=1<<i}
   else if(at>upper)w.done|=1<<i;
  }
  if(w.done!==(1<<HORIZONS.length)-1)still.push(w);
 }
 if(still.length)state.pending[token]=still;else delete state.pending[token];
}
function replayPage(state:State,raw:any[],roles:string[]){
 let maker=0,taker=0,unknown=0,valid=0,invalid=0;
 // API newest-first: reverse to approximate causal chronology; same-second
 // order is source-defined, not proven matching-engine priority.
 for(let i=raw.length-1;i>=0;i--){
  const r=raw[i],role=roles[i],market=String(r?.condition_id||"").toLowerCase();
  const token=String(r?.token_id||""),at=num(r?.timestamp),price=num(r?.price),qty=num(r?.size);
  const side=String(r?.side||"").toUpperCase(),o=num(r?.outcome_index);
  if(String(r?.proxy_wallet||"").toLowerCase()!==RN1||!/^0x[0-9a-f]{64}$/.test(market)||
    !/^[0-9]+$/.test(token)||!(o===0||o===1)||!(side==="BUY"||side==="SELL")||
    !Number.isFinite(at)||!Number.isInteger(at)||!Number.isFinite(price)||price<0||price>1||
    !Number.isFinite(qty)||qty<=0){invalid++;continue}
  valid++;bump(state.totals,"fills");
  bump(state.totals.role,role);
  if(role==="maker")maker++;else if(role==="taker")taker++;else unknown++;
  observeFuture(state,token,price,at);
  const h=state.market[market]||(state.market[market]={q0:0,q1:0,c0:0,c1:0});
  const own=o===0?h.q0:h.q1,opp=o===0?h.q1:h.q0;
  const beforeGap=Math.abs(h.q0-h.q1),beforePaired=Math.min(h.q0,h.q1);
  const position=own<opp?"underweight":own>opp?"overweight":"neutral";
  if(side==="BUY"){
   const laterOwn=own+qty,afterGap=Math.abs((o===0?laterOwn:h.q0)-(o===1?laterOwn:h.q1));
   if(h.q0+h.q1>0){
    group(state.totals.inventory,role,"comparable");
    group(state.totals.inventory,role,afterGap<beforeGap-1e-8?"reduces_gap":afterGap>beforeGap+1e-8?"increases_gap":"unchanged_gap");
    group(state.totals.inventory,role,position);
   }
   if(o===0){h.q0+=qty;h.c0+=qty*price}else{h.q1+=qty;h.c1+=qty*price}
   const newPairs=Math.max(0,Math.min(h.q0,h.q1)-beforePaired);
   if(newPairs>0&&opp>0){
    const opposingAvg=o===0?h.c1/opp:h.c0/opp;
    const gross=newPairs*(1-price-opposingAvg);
    group(state.totals.pair,role,"new_pair_shares",newPairs);
    group(state.totals.pair,role,"paired_gross_proxy",gross);
    group(state.totals.pair,role,"new_pair_events");
   }
   (state.pending[token]||(state.pending[token]=[])).push({t:at,p:price,q:qty,role,position,done:0});
  }else{
   // Executed SELL cashflows are not the same as a merge/redeem. Reduce
   // observed-flow holdings and prorate cost; reject negative proxy holdings.
   if(o===0){const sold=Math.min(qty,h.q0);h.c0=h.q0>0?h.c0*(h.q0-sold)/h.q0:0;h.q0-=sold}
   else{const sold=Math.min(qty,h.q1);h.c1=h.q1>0?h.c1*(h.q1-sold)/h.q1:0;h.q1-=sold}
  }
 }
 // Drop waiting fills whose entire future-trade observation window has
 // elapsed. This bounds memory and preserves a missing-reference denominator.
 const lastAt=Math.max(...raw.map(r=>num(r.timestamp)).filter(Number.isFinite));
 for(const [token,list] of Object.entries(state.pending)){
  const keep:Waiting[]=[];
  for(const w of list){
   for(let k=0;k<HORIZONS.length;k++){
    if(w.done&(1<<k))continue;
    if(lastAt>w.t+HORIZONS[k]+GRACE[k]){
     w.done|=1<<k;
     const coverage=state.totals.coverage||(state.totals.coverage={});
     group(coverage,String(HORIZONS[k]),w.role+"_no_future_reference");
    }
   }
   if(w.done!==(1<<HORIZONS.length)-1)keep.push(w);
  }
  if(keep.length)state.pending[token]=keep;else delete state.pending[token];
 }
 bump(state.totals,"invalid",invalid);
 return {maker,taker,unknown,valid,invalid};
}
async function tick(){
 const claims=await db.unsafe(`UPDATE pi.rn1_replay_jobs SET lease_until=now()+interval '110 seconds',updated_at=now()
 WHERE job_key=$1 AND status='running' AND (lease_until IS NULL OR lease_until<now())
 RETURNING next_page,snapshot_key,frozen_last_page,pages_done,fills_done`,[JOB]);
 if(!claims.length)return {status:"idle_or_leased"};
 const job=claims[0],pageNo=Number(job.next_page);
 try{
  const caps=await db.unsafe("select pg_database_size(current_database())::bigint as db_bytes");
  if(Number(caps[0].db_bytes)>297000000){
   await db.unsafe("update pi.rn1_replay_jobs set status='paused_quota',lease_until=null,last_error='Database safety headroom' where job_key=$1",[JOB]);
   return {status:"paused_quota"};
  }
  const pages=await db.unsafe(`SELECT page_no,storage_key,sha256,row_count,valid_count,
   role_status,maker_fills,taker_fills FROM pi.rn1_full_archive_pages
   WHERE stream='trades_all' AND page_no=$1`,[pageNo]);
  if(!pages.length)throw Error("Missing immutable source page "+pageNo);
  const page=pages[0];
  if(page.role_status!=="verified"){
   await db.unsafe("update pi.rn1_replay_jobs set lease_until=null,last_error='Awaiting independent maker/taker verification of source page' where job_key=$1",[JOB]);
   return {status:"waiting_role_audit",page:pageNo};
  }
  const rawText=await readObject(String(page.storage_key));
  if(await sha(rawText)!==String(page.sha256))throw Error("Immutable source page SHA mismatch");
  const envelope=JSON.parse(rawText);
  const rows=envelope?.source_response?.data;
  if(!Array.isArray(rows)||rows.length!==Number(page.row_count))throw Error("Source row count mismatch");
  const state:State=job.snapshot_key?JSON.parse(await readObject(String(job.snapshot_key))):blank();
  const takers=await takerWindow(rows);
  const roles=assignRoles(rows,takers,page);
  const counts=replayPage(state,rows,roles);
  if(counts.valid!==Number(page.valid_count))throw Error("Source normalization drift versus audited count");
  const nextKey="replay-v1/checkpoints/page-"+String(pageNo).padStart(8,"0")+"-"+String(page.sha256).slice(0,16)+".json.gz";
  const size=await writeObject(nextKey,JSON.stringify(state));
  await db.begin(async tx=>{
   const recorded=await tx.unsafe(`INSERT INTO pi.rn1_replay_pages
    (page_no,source_sha256,maker_fills,taker_fills,unknown_fills,valid_fills,role_quality,snapshot_key)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(page_no) DO NOTHING RETURNING page_no`,
    [pageNo,page.sha256,counts.maker,counts.taker,counts.unknown,counts.valid,counts.unknown?"partial_unknown":"complete",nextKey]);
   if(!recorded.length)throw Error("Replay page was already committed");
   const saved=await tx.unsafe(`UPDATE pi.rn1_replay_jobs SET next_page=$2::bigint,
    pages_done=pages_done+1,fills_done=fills_done+$3,
    maker_fills=maker_fills+$4,taker_fills=taker_fills+$5,unknown_fills=unknown_fills+$6,
    snapshot_key=$7,summary=($8::text)::jsonb,lease_until=null,last_success_at=now(),
    status=CASE WHEN $2::bigint=0 THEN 'complete' ELSE 'running' END,
    completed_at=CASE WHEN $2::bigint=0 THEN now() ELSE completed_at END,
    last_error=null,error_attempts=0,updated_at=now()
    WHERE job_key=$1 AND next_page=$9 AND status='running' RETURNING next_page`,
    [JOB,pageNo-1,counts.valid,counts.maker,counts.taker,counts.unknown,nextKey,JSON.stringify(state.totals),pageNo]);
   if(!saved.length)throw Error("Concurrent replay cursor update");
  });
  if(job.snapshot_key)await deleteObject(String(job.snapshot_key));
  return {status:pageNo===1?"complete":"running",page_processed:pageNo,fills:counts.valid,
   maker:counts.maker,taker:counts.taker,unknown:counts.unknown,checkpoint_bytes:size};
 }catch(e){
  const msg=e instanceof Error?e.message.slice(0,210):"Replay failed";
  await db.unsafe(`UPDATE pi.rn1_replay_jobs SET lease_until=null,error_attempts=error_attempts+1,
  status=CASE WHEN error_attempts+1>=5 THEN 'paused_error' ELSE status END,
  last_error=$2,updated_at=now() WHERE job_key=$1`,[JOB,msg]);
  return {status:"error",page:pageNo,error:msg};
 }
}
Deno.serve(async req=>{
 if(req.method!=="POST")return json({error:"not_found"},404);
 if(!await authorized(req))return json({error:"unauthorized"},403);
 let data:any={};try{data=await req.json()}catch(_){}
 if(data.action!=="rn1_replay_tick")return json({error:"invalid_action"},400);
 const pages=Math.max(1,Math.min(4,Number.isInteger(data.pages)?data.pages:4));
 const results:any[]=[];
 for(let i=0;i<pages;i++){
  const result=await tick();results.push(result);
  if(result.status!=="running")break;
 }
 return json({status:results.at(-1)?.status||"idle",pages_completed:results.filter(x=>x.page_processed).length,results});
});
