// RN1 private non-mutating ledger evidence reader.
// Reads immutable gzip source pages, validates SHA-256 and parses source JSON.
// Never exposes raw wallet archive, storage credentials or arbitrary file access.
import postgres from "npm:postgres@3.4.3";
const HOST=Deno.env.get("SUPABASE_URL")||"",SERVICE=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
const DB=Deno.env.get("SUPABASE_DB_URL")||"";
if(!HOST||!SERVICE||!DB)throw Error("Server-only configuration required");
const db=postgres(DB,{max:1,prepare:false,connect_timeout:12});
const BUCKET="pi-rn1-research-private",WALLET="0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
function reply(data:any,status=200){return Response.json(data,{status,headers:{"Cache-Control":"no-store"}})}
async function authorized(req:Request){
 const token=req.headers.get("x-pi-scheduler-token")||"";
 if(!/^[0-9a-f]{64}$/.test(token))return false;
 const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token));
 const hex=[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
 const rows=await db.unsafe("select 1 from pi.scheduler_auth where single_row_id=1 and token_sha256=$1",[hex]);
 return rows.length===1;
}
async function sha(s:string){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("")}
async function loadPage(stream:string,pageNo:number){
 if(!["trades_all","activity_all"].includes(stream)||!Number.isInteger(pageNo)||pageNo<1||pageNo>10000)throw Error("Invalid page");
 const a=await db.unsafe(`select storage_key,sha256,row_count,min_reported_at,max_reported_at from pi.rn1_full_archive_pages
 where stream=$1 and page_no=$2`,[stream,pageNo]);
 if(!a.length)throw Error("Source page not indexed");
 const info=a[0],url=HOST+"/storage/v1/object/"+BUCKET+"/"+info.storage_key;
 const res=await fetch(url,{headers:{Authorization:"Bearer "+SERVICE,apikey:SERVICE},signal:AbortSignal.timeout(18000)});
 if(!res.ok||!res.body)throw Error("Archive storage HTTP "+res.status);
 const raw=await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).text();
 const digest=await sha(raw);
 if(digest!==String(info.sha256))throw Error("Source SHA-256 mismatch");
 const data=JSON.parse(raw)?.source_response?.data;
 if(!Array.isArray(data)||data.length!==Number(info.row_count))throw Error("Source page size mismatch");
 return {data,info};
}
Deno.serve(async(req:Request)=>{
 if(req.method!=="POST")return reply({error:"Method not allowed"},405);
 try{
  if(!await authorized(req))return reply({error:"Scheduler authorization required"},401);
  const b=await req.json(),action=String(b.action||"");
  if(action==="source_shape"){
   const stream=String(b.stream||""),page=Number(b.page),info=await loadPage(stream,page);
   const keys=info.data.slice(0,5).map((r:any)=>Object.fromEntries(
    Object.entries(r).map(([k,v])=>[k,{type:typeof v,sample:["type","side","outcome","outcome_index"].includes(k)?String(v).slice(0,55):undefined}])));
   return reply({source_sha_verified:true,stream,page,rows:info.data.length,keys});
  }
  return reply({error:"Unknown action"},400);
 }catch(e){return reply({error:String(e).slice(0,160)},500)}
});
