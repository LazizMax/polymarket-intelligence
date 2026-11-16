// Read-only Polygon OrderFilled receipt probe. Scheduler-authenticated, bounded to
// archived RN1 transaction hashes. No private wallet credentials or paid RPC.
import postgres from "npm:postgres@3.4.3";
const dbUrl=Deno.env.get("SUPABASE_DB_URL")||"";
if(!dbUrl)throw Error("Missing DB URL");
const db=postgres(dbUrl,{max:1,prepare:false,connect_timeout:8});
const wallet="0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
const topicV2="0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee";
const topicV1="0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6";
const exchanges=new Set([
 "0xe111180000d2663c0091e4f400237545b87b996b",
 "0xe2222d279d744050d28e00520010520000310f59",
 "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e",
 "0xc5d563a36ae78145c45a50134d48a1215220f80a"
]);
const rpcEndpoints=["https://polygon-bor-rpc.publicnode.com","https://polygon.drpc.org"];
async function hashText(x:string){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(x));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("")}
async function authorized(req:Request){const t=req.headers.get("x-pi-scheduler-token")||"";if(!/^[0-9a-f]{64}$/.test(t))return false;const r=await db.unsafe("select 1 from pi.scheduler_auth where single_row_id=1 and token_sha256=$1",[await hashText(t)]);return r.length===1}
function response(data:unknown,status=200){return Response.json(data,{status,headers:{"Cache-Control":"no-store"}})}
async function receipt(txhash:string){
 let error="unavailable";
 for(const endpoint of rpcEndpoints){
  try{
   const r=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_getTransactionReceipt",params:[txhash]}),signal:AbortSignal.timeout(13000)});
   if(!r.ok){error="rpc_http_"+r.status;continue}
   const j=await r.json();
   if(j.error){error="rpc_error_"+String(j.error.code||"unknown");continue}
   if(!j.result){error="receipt_null";continue}
   return {endpoint,result:j.result};
  }catch(e){error="rpc_network_"+String(e).slice(0,60)}
 }
 throw Error(error);
}
function parseReceipt(x:any){
 const logs=Array.isArray(x.logs)?x.logs:[];
 const events:any[]=[];
 for(const e of logs){
  const address=String(e.address||"").toLowerCase();
  const topics=Array.isArray(e.topics)?e.topics.map((t:string)=>String(t).toLowerCase()):[];
  if(!exchanges.has(address)||topics.length!==4||!(topics[0]===topicV2||topics[0]===topicV1))continue;
  const maker="0x"+topics[2].slice(-40),taker="0x"+topics[3].slice(-40);
  const orderHash=topics[1];
  const data=String(e.data||"0x");
  const words=data.startsWith("0x")?data.slice(2).match(/.{64}/g)||[]:[];
  const v2=topics[0]===topicV2;
  const tokenId=v2&&words.length>=2?BigInt("0x"+words[1]).toString():null;
  events.push({order_hash:orderHash,maker,taker,v2,contract:address,token_id:tokenId,
   log_index:e.logIndex,side:v2&&words.length?Number(BigInt("0x"+words[0])):null});
 }
 return {block_number:x.blockNumber,tx_status:x.status,logs:logs.length,order_filled_logs:events.length,
  rn1_as_maker:events.filter(e=>e.maker===wallet).length,
  rn1_as_taker:events.filter(e=>e.taker===wallet).length,
  order_events:events.filter(e=>e.maker===wallet||e.taker===wallet).slice(0,12)};
}
Deno.serve(async req=>{
 if(req.method!=="POST")return response({error:"method"},405);
 if(!await authorized(req))return response({error:"unauthorized"},403);
 let body:any={};try{body=await req.json()}catch{}
 if(body.action!=="rn1_order_receipt_probe")return response({error:"invalid_action"},400);
 try{
  const take=Math.max(1,Math.min(3,Number(body.limit)||2));
  const samples=await db.unsafe(`select transaction_hash,token_id,fill_count,price_levels from pi.rn1_maker_historical_transaction_lots
   where role='maker' and price_levels>=3 order by first_at desc limit $1`,[take]);
  const out=[];
  for(const sample of samples){
   try{const got=await receipt(sample.transaction_hash);out.push({
     transaction_hash:sample.transaction_hash,
     source_token_id:sample.token_id,source_fills:sample.fill_count,
     source_price_levels:sample.price_levels,
     rpc_endpoint:got.endpoint,receipt:parseReceipt(got.result)
   })}catch(e){out.push({transaction_hash:sample.transaction_hash,error:String(e).slice(0,110)})}
  }
  return response({results:out});
 }catch(e){return response({error:String(e).slice(0,130)},500)}
});
