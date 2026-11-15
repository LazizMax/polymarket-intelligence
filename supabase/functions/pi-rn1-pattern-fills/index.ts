// Frozen 756k RN1 trade setup profiler; source-only private archives.
// No new Polymarket API calls, no execution or trade placement.
// Per-page SHA audit, idempotent SQL transaction, PK-ordered first entries.
import postgres from "npm:postgres@3.4.3";
const db=postgres(Deno.env.get("SUPABASE_DB_URL")||"",{max:1,prepare:false,connect_timeout:10});
const HOST=Deno.env.get("SUPABASE_URL")||"";
const SERVICE=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
const WALLET="0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
const BUCKET="pi-rn1-research-private";
const JOB="rn1_fill_setup_756k_v1";
const reply=(b:unknown,s=200)=>Response.json(b,{status:s,headers:{"Cache-Control":"no-store"}});
async function sha(s:string){const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,"0")).join("")}
async function authorized(req:Request){
 const token=req.headers.get("x-pi-scheduler-token")||"";
 if(!/^[0-9a-f]{64}$/.test(token))return false;
 return (await db.unsafe("select 1 from pi.scheduler_auth where single_row_id=1 and token_sha256=$1",[await sha(token)])).length===1;
}
function marketType(title:string){
 const x=title.toLowerCase();
 if(/exact score|correct score/.test(x))return "Score exact";
 if(/1st half|1h |first half|halftime|half.time/.test(x))return "Mi-temps / 1H";
 if(/map [0-9]+|maps total|map handicap|rounds handicap|rounds total|rounds o\/u/.test(x))return "Cartes/manches esport";
 if(/spread|handicap/.test(x))return "Handicap / spread";
 if(/both teams to score|btts/.test(x))return "Les deux équipes marquent";
 if(/o\/u|over\/under|games total|total rounds|total games|total goals|total points/.test(x))return "Over/Under";
 if(/draw\?|end in a draw|to end in a draw/.test(x))return "Match nul";
 if(/vs\.| vs |will .* win|winner/.test(x))return "Vainqueur / moneyline";
 return "Autre type";
}
function notionalBucket(n:number){
 for(const [v,label] of [[5,"<5"],[20,"5–20"],[50,"20–50"],[100,"50–100"],[250,"100–250"],
  [500,"250–500"],[1000,"500–1000"],[5000,"1000–5000"]] as const)if(n<v)return label;
 return "5000+";
}
type Metric={fills:number,shares:number,usdc:number};
const maps=(obj:any,key:string):Record<string,Metric>=>obj[key]||(obj[key]={});
function put(out:any,type:string,key:string,size:number,notional:number){
 const m=maps(out,type),v=m[key]||(m[key]={fills:0,shares:0,usdc:0});
 v.fills++;v.shares+=size;v.usdc+=notional;
}
type Entry={market_key:string,event_slug:string,first_at:string,first_side:number,first_price:number,first_qty:number,
 first0_at:string|null,first1_at:string|null,first0_price:number|null,first1_price:number|null,
 last_at:string,fills:number};
function inspect(rows:any[]){
 const out:any={price:{},notional:{},utc_hour:{},utc_weekday:{},side:{},
  league:{},market_type:{},league_price:{},type_price:{},league_type:{},total:{fills:0,buys:0,sells:0,shares:0,usdc:0}};
 const entries=new Map<string,Entry>();
 const days=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
 let valid=0,buys=0,sells=0;
 for(const r of rows){
  const market=String(r?.condition_id||"").toLowerCase(),
   at=Number(r?.timestamp),p=Number(r?.price),size=Number(r?.size),
   side=String(r?.side||"").toUpperCase(),o=Number(r?.outcome_index);
  if(String(r?.proxy_wallet||"").toLowerCase()!==WALLET||
   !/^0x[0-9a-f]{64}$/.test(market)||
   !Number.isInteger(at)||at<0||!Number.isFinite(p)||p<0||p>1||
   !Number.isFinite(size)||size<=0||
   (side!=="BUY"&&side!=="SELL")||!(o===0||o===1))continue;
  const time=new Date(at*1000);
  if(Number.isNaN(time.getTime()))continue;
  const league=String(r.event_slug||"").split("-")[0].toLowerCase()||"inconnu";
  const kind=marketType(String(r.title||""));
  const bin=Math.min(19,Math.floor(p*20)),priceBin=String(bin*5).padStart(2,"0")+"–"+String((bin+1)*5).padStart(2,"0")+"%";
  const notional=size*p,timeISO=time.toISOString();
  valid++;out.total.fills++;out.total.shares+=size;out.total.usdc+=notional;
  if(side==="BUY"){buys++;out.total.buys++}else{sells++;out.total.sells++}
  for(const [dimension,key] of [
   ["price",priceBin],["notional",notionalBucket(notional)],
   ["utc_hour",String(time.getUTCHours()).padStart(2,"0")],
   ["utc_weekday",days[time.getUTCDay()]],["side",side],
   ["league",league],["market_type",kind],
   ["league_price",league+"|"+priceBin],["type_price",kind+"|"+priceBin],
   ["league_type",league+"|"+kind]] as string[][])put(out,dimension,key,size,notional);
  if(side!=="BUY")continue;
  let e=entries.get(market);
  if(!e){
   e={market_key:market,event_slug:String(r.event_slug||""),
    first_at:timeISO,first_side:o,first_price:p,first_qty:size,
    first0_at:null,first1_at:null,first0_price:null,first1_price:null,
    last_at:timeISO,fills:0};entries.set(market,e);
  }
  e.fills++;
  if(timeISO<e.first_at){
   e.first_at=timeISO;e.first_side=o;e.first_price=p;e.first_qty=size;
  }
  if(timeISO>e.last_at)e.last_at=timeISO;
  if(o===0&&(!e.first0_at||timeISO<e.first0_at)){e.first0_at=timeISO;e.first0_price=p}
  if(o===1&&(!e.first1_at||timeISO<e.first1_at)){e.first1_at=timeISO;e.first1_price=p}
 }
 return {out,entries:[...entries.values()],valid,buys,sells};
}
async function readSource(key:string){
 if(!HOST||!SERVICE)throw Error("missing private Storage server environment");
 const url=HOST+"/storage/v1/object/"+BUCKET+"/"+key.split("/").map(encodeURIComponent).join("/");
 const r=await fetch(url,{headers:{Authorization:"Bearer "+SERVICE,apikey:SERVICE},
  signal:AbortSignal.timeout(25000)});
 if(!r.ok||!r.body)throw Error("private source unreadable HTTP "+r.status);
 return await new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).text();
}
async function tick(maxPages:number){
 const c=await db.unsafe(`update pi.rn1_pattern_jobs
 set lease_until=now()+interval '110 seconds'
 where job_key=$1 and status='running'
 and (lease_until is null or lease_until<now())
 returning next_page,frozen_last_page,pages_done,fills_done`,[JOB]);
 if(!c.length)return {status:"idle_or_completed_or_leased"};
 const job=c[0],results:any[]=[];
 try{
  const size=await db.unsafe("select pg_database_size(current_database()) bytes");
  if(Number(size[0].bytes)>805306368){
   await db.unsafe("update pi.rn1_pattern_jobs set status='paused',lease_until=null,last_error='768MiB database research safety cap' where job_key=$1",[JOB]);
   return {status:"paused_quota"};
  }
  for(let i=0;i<maxPages&&Number(job.next_page)+i<=Number(job.frozen_last_page);i++){
   const pageNo=Number(job.next_page)+i;
   const r=await db.unsafe(`select storage_key,sha256,valid_count,row_count from pi.rn1_full_archive_pages
    where stream='trades_all' and page_no=$1`,[pageNo]);
   if(r.length!==1)throw Error("Missing immutable page "+pageNo);
   const page=r[0],raw=await readSource(String(page.storage_key));
   if(await sha(raw)!==page.sha256)throw Error("Immutable raw page SHA mismatch "+pageNo);
   const payload=JSON.parse(raw);
   const rows=payload?.source_response?.data;
   if(!Array.isArray(rows)||rows.length!==Number(page.row_count))throw Error("Source row count drift "+pageNo);
   const data=inspect(rows);
   if(data.valid!==Number(page.valid_count))throw Error("Normalized valid count drift "+pageNo);
   await db.begin(async tx=>{
    const added=await tx.unsafe(`insert into pi.rn1_pattern_page_stats(page_no,source_sha256,fills,buys,sells,summary)
     values($1,$2,$3,$4,$5,($6::text)::jsonb) on conflict do nothing returning page_no`,
     [pageNo,page.sha256,data.valid,data.buys,data.sells,JSON.stringify(data.out)]);
    if(added.length!==1)throw Error("Pattern page already seen without cursor advance "+pageNo);
    if(data.entries.length){
     await tx.unsafe(`insert into pi.rn1_pattern_market_entries as e
      (market_key,event_slug,first_at,first_side,first_price,first_qty,first0_at,first1_at,
       first0_price,first1_price,last_at,fills)
      select x.market_key,x.event_slug,x.first_at,x.first_side,x.first_price,x.first_qty,
       x.first0_at,x.first1_at,x.first0_price,x.first1_price,x.last_at,x.fills
      from jsonb_to_recordset(($1::text)::jsonb) as x(
       market_key text,event_slug text,first_at timestamptz,first_side smallint,
       first_price numeric,first_qty numeric,first0_at timestamptz,first1_at timestamptz,
       first0_price numeric,first1_price numeric,last_at timestamptz,fills bigint)
      on conflict(market_key) do update set
       event_slug=coalesce(nullif(e.event_slug,''),excluded.event_slug),
       first_side=case when excluded.first_at<e.first_at then excluded.first_side else e.first_side end,
       first_price=case when excluded.first_at<e.first_at then excluded.first_price else e.first_price end,
       first_qty=case when excluded.first_at<e.first_at then excluded.first_qty else e.first_qty end,
       first_at=least(e.first_at,excluded.first_at),
       first0_price=case when excluded.first0_at is not null
         and (e.first0_at is null or excluded.first0_at<e.first0_at)
         then excluded.first0_price else e.first0_price end,
       first1_price=case when excluded.first1_at is not null
         and (e.first1_at is null or excluded.first1_at<e.first1_at)
         then excluded.first1_price else e.first1_price end,
       first0_at=coalesce(least(e.first0_at,excluded.first0_at),e.first0_at,excluded.first0_at),
       first1_at=coalesce(least(e.first1_at,excluded.first1_at),e.first1_at,excluded.first1_at),
       last_at=greatest(e.last_at,excluded.last_at),fills=e.fills+excluded.fills`,
       [JSON.stringify(data.entries)]);
    }
    const advance=await tx.unsafe(`update pi.rn1_pattern_jobs
     set next_page=$2,pages_done=pages_done+1,fills_done=fills_done+$3,
     last_success_at=now(),last_error=null
     where job_key=$1 and next_page=$4
     returning pages_done`,[JOB,pageNo+1,data.valid,pageNo]);
    if(advance.length!==1)throw Error("Progress cursor raced "+pageNo);
   });
   results.push({page:pageNo,fills:data.valid,entry_markets:data.entries.length});
  }
  const completed=Number(job.next_page)+results.length>Number(job.frozen_last_page);
  await db.unsafe(`update pi.rn1_pattern_jobs
  set status=case when $2 then 'complete' else 'running' end,
   completed_at=case when $2 then now() else null end,
   lease_until=null,last_error=null where job_key=$1`,[JOB,completed]);
  return {status:completed?"complete":"running",pages:results.length,
   fills:results.reduce((a,x)=>a+x.fills,0),last_page:results.at(-1)?.page||null};
 }catch(e){
  const error=String(e).slice(0,250);
  await db.unsafe("update pi.rn1_pattern_jobs set status='error',lease_until=null,last_error=$2 where job_key=$1",[JOB,error]);
  return {status:"error",error,processed:results.length};
 }
}
Deno.serve(async req=>{
 if(req.method!=="POST")return reply({error:"method_not_allowed"},405);
 if(!await authorized(req))return reply({error:"forbidden"},403);
 let b:any={};try{b=await req.json()}catch(_){}
 if(b.action!=="profile_rn1_frozen_fills")return reply({error:"unknown_action"},400);
 return reply(await tick(Math.min(12,Math.max(1,Number.isInteger(b.count)?b.count:6))));
});