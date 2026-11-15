// Source-of-truth cumulative economic PnL from public Polymarket API.
// The JSON numeric payload stays raw until PostgreSQL parses it. This is
// wallet-level performance, not an RN1 causal strategy performance estimate.
import postgres from "npm:postgres@3.4.3";
const dbUrl=Deno.env.get("SUPABASE_DB_URL")||"";
if(!dbUrl)throw Error("Database connection unavailable");
const db=postgres(dbUrl,{max:1,prepare:false,connect_timeout:10});
const WALLET="0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
const SOURCE="https://data-api.polymarket.com/v2/user-pnl?user="+WALLET+"&interval=all&fidelity=1d";
const reply=(data:unknown,status=200)=>Response.json(data,{status,headers:{"Cache-Control":"no-store"}});
async function digest(token:string){
 const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token));
 return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function auth(req:Request){
 const token=req.headers.get("x-pi-scheduler-token")||"";
 if(!/^[0-9a-f]{64}$/.test(token))return false;
 const rows=await db.unsafe("select 1 from pi.scheduler_auth where single_row_id=1 and token_sha256=$1",[await digest(token)]);
 return rows.length===1;
}
async function fetchOfficial(){
 let r:Response|undefined;
 for(let attempt=0;attempt<3;attempt++){
  r=await fetch(SOURCE,{headers:{accept:"application/json"},signal:AbortSignal.timeout(25000),cache:"no-store"});
  if(r.ok)break;
  if(![429,503].includes(r.status)||attempt===2)throw Error("Polymarket PnL API "+r.status);
  await new Promise(resolve=>setTimeout(resolve,1300*(attempt+1)));
 }
 if(!r?.ok)throw Error("Official PnL fetch not successful");
 const raw=await r.text();
 if(raw.length<100||raw.length>1500000)throw Error("Unexpected official response size");
 const parsed=JSON.parse(raw);
 if(parsed?.data?.proxy_wallet!==WALLET||!Array.isArray(parsed?.data?.points)||
    parsed.data.points.length<10||parsed.data.points.length>3000||
    parsed.data.interval!=="all"||parsed.data.fidelity!=="1d")
  throw Error("Unexpected wallet or interval in official PnL API");
 // SQL JSONB parsing uses original wire-format numeric literals, NOT JS Number.
 const rows=await db.unsafe(`
 WITH data AS (SELECT ($1::text)::jsonb AS response),
 valid AS(SELECT response->'data'->'points' as points FROM data
  WHERE response->'data'->>'proxy_wallet'=$2 AND response->'data'->>'interval'='all'
   AND response->'data'->>'fidelity'='1d'),
 records AS(SELECT elem FROM valid,LATERAL jsonb_array_elements(points) elem),
 upsert AS(
 INSERT INTO pi.rn1_official_pnl_points(wallet,observed_at,source_block,record,source_endpoint)
 SELECT $2,to_timestamp((elem->>'timestamp')::bigint),(elem->>'source_block')::bigint,
 elem,'/v2/user-pnl?interval=all&fidelity=1d'
 FROM records
 WHERE elem ? 'economic_pnl' AND (elem->>'timestamp') ~ '^[0-9]{10}$'
 ON CONFLICT(wallet,observed_at) DO UPDATE
 SET source_block=excluded.source_block,record=excluded.record,
 fetched_at=now(),source_endpoint=excluded.source_endpoint
 RETURNING observed_at)
 SELECT count(*)::int updated,min(observed_at)::text earliest,
 max(observed_at)::text latest FROM upsert`,[raw,WALLET]);
 const x=rows[0];
 if(!x?.updated||x.updated<10)throw Error("Official PnL upsert unexpectedly empty");
 return {status:"updated",points:x.updated,earliest:x.earliest,latest:x.latest};
}
Deno.serve(async req=>{
 if(req.method!=="POST")return reply({error:"method_not_allowed"},405);
 if(!await auth(req))return reply({error:"forbidden"},403);
 let arg:any={};try{arg=await req.json()}catch(_){}
 if(arg.action!=="refresh_official_rn1_pnl")return reply({error:"unknown_action"},400);
 try{return reply(await fetchOfficial())}
 catch(e){return reply({status:"error",error:String(e).slice(0,220)},500)}
});