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
const pilotMarkets=new Set([
 "0xdd757794febc6cfd6bcf89bbcbac103fb059dec17a5b87c11146ef61d3d38bd2",
 "0x48d00a6775eb36ade7d947119c6ce9e2f2fe665b79a95de431dec3917537ca7e",
 "0x67ffbb71f10ab6f28715b36c369d0591669aa8d548c8785530afbc3b4180b0a4"
]);
async function scanPilotMarket(market:string,holdout=false){
 if(holdout){
  const matches=await db.unsafe("select 1 from pi.rn1_ledger_holdout_selection where market_key=$1 and sample_version='rn1-independent-ledger-20261118-v1'",[market]);
  if(matches.length!==1)throw Error("Holdout market not selected");
 }else if(!pilotMarkets.has(market))throw Error("Pilot not selected");
 const marketRows=await db.unsafe(`select market_key,title,fills,buy0_shares,buy1_shares,
 buy0_cost,buy1_cost,sell0_shares,sell1_shares,min_trade_at,max_trade_at
 from pi.rn1_full_market_metrics where wallet=$1 and market_key=$2`,[WALLET,market]);
 if(marketRows.length!==1)throw Error("Market summary unavailable");
 const activityRows=await db.unsafe(`select kind,events,reported_usdc_size,min_event_at,max_event_at
 from pi.rn1_full_activity_metrics where wallet=$1 and market_key=$2
 order by kind`,[WALLET,market]);
 const m=marketRows[0],important=activityRows.filter((r:any)=>r.kind!=="TRADE");
 const first=Math.min(new Date(m.min_trade_at).getTime(),...important.map((x:any)=>new Date(x.min_event_at).getTime()));
 const last=Math.max(new Date(m.max_trade_at).getTime(),...important.map((x:any)=>new Date(x.max_event_at).getTime()));
 const start=new Date(first-7200000),end=new Date(last+7200000);
 if(end.getTime()-start.getTime()>259200000)throw Error("Pilot time range exceeds 72h");
 const pages=await db.unsafe(`select stream,page_no
 from pi.rn1_full_archive_pages where stream in('trades_all','activity_all')
 and max_reported_at >= $1 and min_reported_at <= $2
 order by stream,page_no`,[start.toISOString(),end.toISOString()]);
 if(pages.length>70||pages.length<1)throw Error("Source page count outside bounded pilot");
 const results:any[]=[];
 for(let i=0;i<pages.length;i+=5){
  const group=await Promise.all(pages.slice(i,i+5).map(async(p:any)=>{
   const obj=await loadPage(String(p.stream),Number(p.page_no));
   const matches=obj.data.filter((v:any)=>String(v.condition_id||"").toLowerCase()===market&&String(v.proxy_wallet||"").toLowerCase()===WALLET);
   return {stream:String(p.stream),page:Number(p.page_no),
    data:matches.map((v:any)=>({
     stream:String(p.stream),page:Number(p.page_no),t:Number(v.timestamp),
     kind:p.stream==="trades_all"?"TRADE":String(v.type||"UNKNOWN"),
     side:v.side??null,index:v.outcome_index??null,
     qty:v.size??null,usdc_size:v.usdc_size??null,price:v.price??null,
     token:v.token_id??null,tx:v.transaction_hash??null,
     source_keys:p.stream==="activity_all"&&v.type!=="TRADE"?Object.keys(v):undefined
    }))};
  }));
  results.push(...group);
 }
 const trades=results.flatMap(x=>x.stream==="trades_all"?x.data:[]);
 const act=results.flatMap(x=>x.stream==="activity_all"?x.data.filter((v:any)=>v.kind!=="TRADE"):[]);
 const timeline=[...trades,...act].sort((a:any,b:any)=>a.t-b.t||a.kind.localeCompare(b.kind)||a.page-b.page);
 const perKind=Object.fromEntries([...new Set(act.map(v=>v.kind))].map(kind=>[kind,
 {events:act.filter(v=>v.kind===kind).length,
 size_total:act.filter(v=>v.kind===kind).reduce((n:number,v:any)=>n+Number(v.qty||0),0),
 usdc_size_total:act.filter(v=>v.kind===kind).reduce((n:number,v:any)=>n+Number(v.usdc_size||0),0)}]));
 return {market,market_summary:m,activity_summary:activityRows,
 source_verified_pages:pages.length,trades_pages:pages.filter((x:any)=>x.stream==="trades_all").length,
 activity_pages:pages.filter((x:any)=>x.stream==="activity_all").length,
 source_window_start:start.toISOString(),source_window_end:end.toISOString(),
 trade_rows:trades.length,activity_nontrade_rows:act.length,
 trade_count_match:trades.length===Number(m.fills),
 per_kind:perKind,timeline};
}
Deno.serve(async(req:Request)=>{
 if(req.method!=="POST")return reply({error:"Method not allowed"},405);
 try{
  if(!await authorized(req))return reply({error:"Scheduler authorization required"},401);
  const b=await req.json(),action=String(b.action||"");
  if(action==="scan_holdout_market"){
   return reply(await scanPilotMarket(String(b.market||"").toLowerCase(),true));
  }
  if(action==="scan_pilot_market"){
   return reply(await scanPilotMarket(String(b.market||"").toLowerCase()));
  }
  if(action==="source_shape"){
   const stream=String(b.stream||""),page=Number(b.page),info=await loadPage(stream,page);
   const keys=info.data.slice(0,5).map((r:any)=>Object.fromEntries(
    Object.entries(r).map(([k,v])=>[k,{type:typeof v,sample:["type","side","outcome","outcome_index"].includes(k)?String(v).slice(0,55):undefined}])));
   return reply({source_sha_verified:true,stream,page,rows:info.data.length,keys});
  }
  return reply({error:"Unknown action"},400);
 }catch(e){return reply({error:String(e).slice(0,160)},500)}
});
