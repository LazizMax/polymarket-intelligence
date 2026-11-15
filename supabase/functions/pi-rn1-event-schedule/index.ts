// RN1 event schedule enrichment. PUBLIC Gamma metadata only.
// The event START TIME is gameStartTime/startTime, never market startDate
// (market creation) or endDate (settlement/close).
import postgres from "npm:postgres@3.4.3";
const db=postgres(Deno.env.get("SUPABASE_DB_URL")||"",{max:2,prepare:false,connect_timeout:10});
const reply=(data:unknown,status=200)=>Response.json(data,{status,headers:{"Cache-Control":"no-store"}});
async function hash(token:string){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("")}
async function auth(req:Request){
 const token=req.headers.get("x-pi-scheduler-token")||"";
 if(!/^[0-9a-f]{64}$/.test(token))return false;
 const rows=await db.unsafe("select 1 from pi.scheduler_auth where single_row_id=1 and token_sha256=$1",[await hash(token)]);
 return rows.length===1;
}
function iso(raw:unknown):string|null{
 if(typeof raw!=="string"||!raw.trim())return null;
 const millis=Date.parse(raw);
 return Number.isFinite(millis)&&millis>1720000000000&&millis<1950000000000?
 new Date(millis).toISOString():null;
}
async function getEvent(job:any){
 const slug=String(job.event_slug);
 if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,240}$/.test(slug))throw Error("unsafe slug");
 const response=await fetch("https://gamma-api.polymarket.com/events/slug/"+encodeURIComponent(slug),{
   headers:{accept:"application/json"},signal:AbortSignal.timeout(19000)});
 if(!response.ok)throw Error("gamma_http_"+response.status);
 const raw=await response.text();
 if(raw.length>1250000||raw.length<2)throw Error("unexpected_gamma_response_size");
 const obj=JSON.parse(raw);
 if(!obj||typeof obj!=="object"||String(obj.slug||"")!==slug)
  throw Error("gamma_event_slug_mismatch");
 const markets=Array.isArray(obj.markets)?obj.markets:[];
 const marketTime=markets.map((m:any)=>iso(m?.gameStartTime)).find(Boolean)||null;
 const eventTime=iso(obj.startTime);
 const start=eventTime||marketTime;
 const source=start?(eventTime?"event_startTime":"market_gameStartTime"):null;
 const marketCreated=iso(obj.startDate);
 const status=start?"ok":"missing";
 await db.unsafe(`update pi.rn1_event_schedule
  set status=$2,start_at=$3::timestamptz,source_start_at=$4::timestamptz,
  start_source=$5,fetched_at=now(),lease_until=null,last_error=null
  where event_slug=$1`,[slug,status,start,marketCreated,source]);
 return {status,slug,source};
}
async function tick(count:number){
 const claimed=await db.unsafe(`with q as(
  select event_slug from pi.rn1_event_schedule
  where (status='pending' or (status='working' and lease_until<now()))
    and attempts<5
  order by case when selection='top_activity' then 0 else 1 end,
           event_fills desc,event_slug
  limit $1 for update skip locked)
 update pi.rn1_event_schedule d set status='working',attempts=attempts+1,
  lease_until=now()+interval '65 seconds'
 from q where q.event_slug=d.event_slug
 returning d.event_slug,d.attempts`,[count]);
 const results:any[]=[];
 for(let offset=0;offset<claimed.length;offset+=3){
  const batch=claimed.slice(offset,offset+3);
  const out=await Promise.all(batch.map(async j=>{
   try{return await getEvent(j)}
   catch(e){
    const error=String(e).slice(0,160);
    const retriable=/429|503|504|timeout|network|500/.test(error)&&Number(j.attempts)<5;
    await db.unsafe(`update pi.rn1_event_schedule
     set status=$2,last_error=$3,lease_until=null,fetched_at=now()
     where event_slug=$1`,[j.event_slug,retriable?"pending":"error",error]);
    return {slug:j.event_slug,status:retriable?"retry":"error",error};
   }
  }));
  results.push(...out);
 }
 const totals=await db.unsafe(`select status,count(*)::int n,
 sum(event_fills)::bigint event_fills from pi.rn1_event_schedule group by status`);
 return {claimed:claimed.length,success:results.filter(r=>r.status==="ok").length,
 missing:results.filter(r=>r.status==="missing").length,
 retry:results.filter(r=>r.status==="retry").length,
 errors:results.filter(r=>r.status==="error").length,stats:totals};
}
Deno.serve(async req=>{
 if(req.method!=="POST")return reply({error:"method_not_allowed"},405);
 if(!await auth(req))return reply({error:"forbidden"},403);
 let body:any={};try{body=await req.json()}catch(_){}
 if(body.action!=="enrich_rn1_events")return reply({error:"unknown_action"},400);
 try{return reply(await tick(Math.min(15,Math.max(1,Number.isInteger(body.count)?body.count:9))))}
 catch(e){return reply({error:String(e).slice(0,200)},500)}
});