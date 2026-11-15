// Private source coverage diagnostic. No trades, keys or raw archive payload in response.
import postgres from "npm:postgres@3.4.3";
const url=Deno.env.get("SUPABASE_URL")||"",key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"",dbUrl=Deno.env.get("SUPABASE_DB_URL")||"";
if(!url||!key||!dbUrl)throw Error("server configuration missing");
const db=postgres(dbUrl,{max:1,prepare:false,connect_timeout:10});
const send=(x:any,status=200)=>Response.json(x,{status,headers:{"Cache-Control":"no-store"}});
async function allow(req:Request){const token=req.headers.get("x-pi-scheduler-token")||"";if(!/^[0-9a-f]{64}$/.test(token))return false;
 const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token));const hash=[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,"0")).join("");
 const r=await db.unsafe("select 1 from pi.scheduler_auth where single_row_id=1 and token_sha256=$1",[hash]);return r.length===1;}
async function run(pageNo:number){
 const r=await db.unsafe("select storage_key,min_reported_at,max_reported_at,sha256,row_count from pi.rn1_full_archive_pages where stream='trades_all' and page_no=$1",[pageNo]);if(!r.length)throw Error("source page missing");
 const page=r[0],storage=await fetch(url+"/storage/v1/object/pi-rn1-research-private/"+String(page.storage_key),{headers:{Authorization:"Bearer "+key,apikey:key},signal:AbortSignal.timeout(15000)});
 if(!storage.ok||!storage.body)throw Error("archive read "+storage.status);
 const text=await new Response(storage.body.pipeThrough(new DecompressionStream("gzip"))).text();
 const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));
 const hash=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
 if(hash!==page.sha256)throw Error("archive sha mismatch");
 const raw=JSON.parse(text)?.source_response?.data;if(!Array.isArray(raw)||raw.length!==Number(page.row_count))throw Error("archive count mismatch");
 const byToken=new Map<string,{n:number;start:number;end:number}>();
 for(const x of raw){const id=String(x.token_id||""),t=Number(x.timestamp);if(!/^[0-9]{20,100}$/.test(id)||!Number.isSafeInteger(t))continue;const prev=byToken.get(id)||{n:0,start:t,end:t};prev.n++;prev.start=Math.min(prev.start,t);prev.end=Math.max(prev.end,t);byToken.set(id,prev);}
 const ordered=[...byToken.entries()].sort((a,b)=>b[1].n-a[1].n||a[0].localeCompare(b[0]));
 const results:any[]=[];
 for(const [id,p] of ordered.slice(0,4)){
  const u=new URL("https://clob.polymarket.com/prices-history");u.searchParams.set("market",id);u.searchParams.set("startTs",String(p.start-600));u.searchParams.set("endTs",String(p.end+5400));u.searchParams.set("fidelity","1");
  try{const res=await fetch(u,{signal:AbortSignal.timeout(12000)});const j=res.ok?await res.json():null;
   const points=Array.isArray(j?.history)?j.history.filter((x:any)=>Number.isFinite(Number(x?.t))&&Number.isFinite(Number(x?.p))):[];
   const relevant=points.filter((x:any)=>Number(x.t)>=p.start&&Number(x.t)<=p.end+3900);
   results.push({fills:p.n,http_status:res.status,points:points.length,window_points:relevant.length,
    last_point_epoch:points.length?Number(points.at(-1)?.t):null,has_15m_references:raw.some((x:any)=>String(x.token_id)===id&&relevant.some((z:any)=>Number(z.t)>=Number(x.timestamp)+900&&Number(z.t)<=Number(x.timestamp)+1080))});
  }catch(e){results.push({fills:p.n,error:String(e).slice(0,100)})}
 }
 return {page:pageNo,trades:raw.length,tokens:byToken.size,most_frequent_token_coverage:results,
  warning:"CLOB historical prices are an independent indicative time series, not an archived best bid/ask"};
}
Deno.serve(async req=>{if(req.method!=="POST")return send({error:"bad_method"},405);if(!await allow(req))return send({error:"unauthorized"},403);
 let payload:any={};try{payload=await req.json()}catch(_){};if(payload.action!=="probe"||!Number.isInteger(payload.page_no)||payload.page_no<1||payload.page_no>10000)return send({error:"invalid_request"},400);
 try{return send(await run(payload.page_no))}catch(e){return send({error:String(e).slice(0,180)},500)}});
