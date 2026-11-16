// RN1 predecision external-fair-value experiment. This worker is DISABLED
// until the operator adds RN1_ODDS_API_KEY to Supabase Edge secrets.
// Never polls ESPN (unofficial), never places a trade. Private scheduler only.
// Provider: https://api.theoddsapi.com/odds/?sport_key=basketball_nba&markets=h2h
// Free-key usage: one poll/hour, <=24 per UTC day, <=5000 deduped rows.
import postgres from "npm:postgres@3.4.3";
import { normalizePayload } from "./normalize.ts";
const dbUrl=Deno.env.get("SUPABASE_DB_URL")||"";
if(!dbUrl)throw Error("Database connection unavailable");
const db=postgres(dbUrl,{max:1,prepare:false,connect_timeout:10,idle_timeout:5});
const reply=(v:unknown,status=200)=>Response.json(v,{status,headers:{"cache-control":"no-store"}});
const sha256=async(s:string)=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s)))].map(x=>x.toString(16).padStart(2,"0")).join("");
async function allowed(req:Request){
 const tok=req.headers.get("x-pi-scheduler-token")||"";
 if(!/^[0-9a-f]{64}$/.test(tok))return false;
 const r=await db.unsafe("select 1 from pi.scheduler_auth where single_row_id=1 and token_sha256=$1",[await sha256(tok)]);
 return r.length===1;
}
async function state(status:string,extra:Record<string,unknown>={}){
 await db.unsafe(`update pi.rn1_external_odds_collector_state set status=$1,updated_at=now(),
  last_inserted=coalesce($2::integer,last_inserted),last_error_kind=$3::text
  where singleton=1`,[status,extra.inserted??null,extra.error??null]);
}
async function collect(){
 const apiKey=(Deno.env.get("RN1_ODDS_API_KEY")||"").trim();
 if(apiKey.length<16){await state("missing_api_key");return {status:"missing_api_key",requests:0};}
 const meta=await db.unsafe("select * from pi.rn1_external_odds_collector_state where singleton=1 limit 1");
 const m=meta[0],now=new Date(),day=now.toISOString().slice(0,10);
 const calls=m?.day_utc&&String(m.day_utc).slice(0,10)===day?Number(m.calls_today)||0:0;
 const last=m?.last_call_at?new Date(m.last_call_at).getTime():0;
 if(calls>=24||m?.status==="rate_limited"&&calls>=23)return {status:"rate_limited",requests:0,calls_today:calls};
 if(now.getTime()-last<50*60e3)return {status:"cooldown",requests:0,calls_today:calls};
 const count=await db.unsafe("select count(*)::integer n from pi.rn1_external_odds_observations");
 if(Number(count[0]?.n||0)>=5000){await state("paused_cap");return{status:"paused_cap",requests:0};}
 // One provider request is budgeted BEFORE fetch (including errors/429).
 await db.unsafe(`update pi.rn1_external_odds_collector_state
  set day_utc=$1::date,calls_today=$2,last_call_at=now(),status='collecting',updated_at=now()
  where singleton=1`,[day,calls+1]);
 const u="https://api.theoddsapi.com/odds/?sport_key=basketball_nba&markets=h2h&bookmakers=draftkings,fanduel";
 try{
  const r=await fetch(u,{headers:{"x-api-key":apiKey,"accept":"application/json"},signal:AbortSignal.timeout(15000),cache:"no-store"});
  if(r.status===429){await state("rate_limited",{error:"provider_429"});return {status:"rate_limited",requests:1,calls_today:calls+1};}
  if(!r.ok){await state("provider_error",{error:"http_"+r.status});return {status:"provider_error",requests:1,calls_today:calls+1};}
  const txt=await r.text();
  if(txt.length>400000)throw Error("oversize_response");
  const received=new Date();
  const rows=normalizePayload(JSON.parse(txt),received).slice(0,Math.max(0,5000-Number(count[0]?.n||0)));
  let inserted=0;
  if(rows.length){
   const out=await db.unsafe(`
    insert into pi.rn1_external_odds_observations(
     provider,source_event_id,event_slug,bookmaker,home_team,away_team,start_at,
     first_seen_at,book_updated_at,home_american,away_american,
     home_fair_probability,away_fair_probability)
    select x.provider,x.source_event_id,x.event_slug,x.bookmaker,x.home_team,x.away_team,
     x.start_at,x.first_seen_at,x.book_updated_at,x.home_american,x.away_american,
     x.home_fair_probability,x.away_fair_probability
    from jsonb_to_recordset(($1::jsonb #>> '{}')::jsonb) as x(
     provider text,source_event_id text,event_slug text,bookmaker text,
     home_team text,away_team text,start_at timestamptz,first_seen_at timestamptz,
     book_updated_at timestamptz,home_american integer,away_american integer,
     home_fair_probability double precision,away_fair_probability double precision)
    on conflict do nothing returning id`,[JSON.stringify(rows)]);
   inserted=out.length;
  }
  await db.unsafe(`update pi.rn1_external_odds_collector_state set status='ready',
   last_success_at=now(),last_inserted=$1,last_error_kind=null,updated_at=now()
   where singleton=1`,[inserted]);
  return {status:"ready",requests:1,calls_today:calls+1,normalized:rows.length,inserted};
 }catch(e){
  const kind=e instanceof Error && ["oversize_response","provider_payload_shape"].includes(e.message)?e.message:"request_or_parse_failed";
  await state("provider_error",{error:kind});
  return {status:"provider_error",requests:1,calls_today:calls+1,error_kind:kind};
 }
}
Deno.serve(async(req:Request)=>{
 if(req.method!=="POST")return reply({error:"POST required"},405);
 if(!await allowed(req))return reply({error:"Unauthorized"},401);
 let payload:unknown={};try{payload=await req.json()}catch{}
 if((payload as any)?.action!=="odds_capture")return reply({error:"Unknown action"},400);
 try{return reply(await collect())}catch(e){console.error("rn1 odds collect",e instanceof Error?e.name:"unknown");return reply({error:"collect failed"},500)}
});
