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
  const side=v2&&words.length?Number(BigInt("0x"+words[0])):null;
  const makerRaw=v2&&words.length>=4?BigInt("0x"+words[2]):null;
  const takerRaw=v2&&words.length>=4?BigInt("0x"+words[3]):null;
  const price=v2&&makerRaw!==null&&takerRaw!==null&&makerRaw>0n&&takerRaw>0n
    ?(side===0?Number(makerRaw)/Number(takerRaw):Number(takerRaw)/Number(makerRaw)):null;
  const shares=v2&&makerRaw!==null&&takerRaw!==null
    ?Number(side===0?takerRaw:makerRaw)/1e6:null;
  events.push({order_hash:orderHash,maker,taker,v2,contract:address,token_id:tokenId,
   log_index:e.logIndex,side,price,shares});
 }
 return {block_number:x.blockNumber,tx_status:x.status,logs:logs.length,order_filled_logs:events.length,
  rn1_as_maker:events.filter(e=>e.maker===wallet).length,
  rn1_as_taker:events.filter(e=>e.taker===wallet).length,
  order_events:events.filter(e=>e.maker===wallet||e.taker===wallet).slice(0,12)};
}
async function matchNextSignedOrder(){
 const candidates=await db.unsafe(`select t.transaction_hash,t.fill_count,t.price_levels
  from pi.rn1_maker_historical_transaction_lots t
  where t.role='maker' and t.fill_count>1
    and not exists(select 1 from pi.rn1_maker_onchain_tx_audit a where a.transaction_hash=t.transaction_hash)
  order by t.price_levels desc,t.first_at desc limit 1`);
 if(!candidates.length)return {status:"complete"};
 const sample=candidates[0],txhash=String(sample.transaction_hash);
 const fills=await db.unsafe(`select fingerprint,token_id,price::text price,shares::text shares
 from pi.rn1_maker_historical_fills where transaction_hash=$1 and role='maker'
 order by fingerprint`,[txhash]);
 const got=await receipt(txhash);
 const parsed=parseReceipt(got.result);
 if(parsed.tx_status!=="0x1")throw Error("Receipt not confirmed");
 const makerEvents=parsed.order_events.filter((e:any)=>e.maker===wallet && e.v2 && e.side===0);
 const groups=makerEvents.filter((e:any)=>fills.some((f:any)=>f.token_id===e.token_id));
 const selected:any[]=[];
 let outcome:"confirmed"|"unmatched"|"ambiguous"="confirmed",reason="";
 if(groups.length!==fills.length || parsed.rn1_as_maker>parsed.order_events.length){
  outcome="unmatched";reason="Maker receipt/source count mismatch";
 }else{
  const used=new Set<number>();
  for(const fill of fills){
   const p=Number(fill.price),q=Number(fill.shares);
   const choices=groups.map((e:any,i:number)=>({e,i})).filter(({e,i})=>
    !used.has(i) && e.token_id===fill.token_id &&
    Number.isFinite(e.price) && Number.isFinite(e.shares) &&
    Math.abs(e.price-p)<=0.000002 &&
    Math.abs(e.shares-q)<=Math.max(0.000002,q*0.00000001));
   if(choices.length!==1){outcome=choices.length>1?"ambiguous":"unmatched";reason="Non-unique price/quantity/token correspondence";break}
   const {e,i}=choices[0];used.add(i);
   if(!/^0x[0-9a-f]{64}$/.test(e.order_hash)){outcome="unmatched";reason="Invalid order hash";break}
   selected.push({fingerprint:fill.fingerprint,order_hash:e.order_hash,
    log_index:Number(BigInt(e.log_index))});
  }
 }
 if(outcome==="confirmed"&&selected.length!==fills.length){outcome="unmatched";reason="Incomplete matching"}
 await db.begin(async tx=>{
  if(outcome==="confirmed"){
   const updated=await tx.unsafe(`update pi.rn1_maker_historical_fills f
     set maker_order_hash=x.order_hash,maker_order_log_index=x.log_index
     from jsonb_to_recordset(($1::text)::jsonb) as x(fingerprint text,order_hash text,log_index integer)
     where f.fingerprint=x.fingerprint and f.transaction_hash=$2
       and (f.maker_order_hash is null or f.maker_order_hash=x.order_hash)
     returning f.fingerprint`,[JSON.stringify(selected),txhash]);
   if(updated.length!==fills.length)throw Error("Order ID update did not match all source rows");
  }
  await tx.unsafe(`insert into pi.rn1_maker_onchain_tx_audit
   (transaction_hash,source_fills,maker_logs,matched_fills,status,block_number,rpc_provider,note)
   values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(transaction_hash) do nothing`,
   [txhash,fills.length,parsed.rn1_as_maker,outcome==="confirmed"?selected.length:0,
    outcome,Number(BigInt(parsed.block_number)),got.endpoint,reason||null]);
 });
 return {status:outcome,txhash,source_fills:fills.length,maker_logs:parsed.rn1_as_maker,
  confirmed_orders:outcome==="confirmed"?selected.length:0,price_levels:sample.price_levels};
}
async function getLogsProbe(span=50){
 const known=await db.unsafe(`select transaction_hash from pi.rn1_maker_onchain_tx_audit
 where status='confirmed' order by verified_at desc limit 1`);
 if(!known.length)throw Error("No confirmed onchain transaction");
 const txhash=String(known[0].transaction_hash);
 const first=await receipt(txhash);
 const center=BigInt(first.result.blockNumber);
 const radius=BigInt(Math.max(5,Math.min(2500,span)));
 const from=center>radius?center-radius:0n,to=center+radius;
 const filter={address:["0xe111180000d2663c0091e4f400237545b87b996b","0xe2222d279d744050d28e00520010520000310f59"],
   fromBlock:"0x"+from.toString(16),toBlock:"0x"+to.toString(16),
   topics:[topicV2,null,"0x"+wallet.slice(2).padStart(64,"0")]};
 const errors:any[]=[];
 for(const endpoint of rpcEndpoints){
  try{
   const r=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_getLogs",params:[filter]}),signal:AbortSignal.timeout(20000)});
   if(!r.ok){errors.push("http_"+r.status);continue}
   const j=await r.json();
   if(j.error){errors.push("rpc_"+String(j.error.message||j.error.code).slice(0,100));continue}
   if(!Array.isArray(j.result))throw Error("Unexpected logs response");
   const found=j.result.filter((x:any)=>x.transactionHash?.toLowerCase()===txhash);
   const dec=parseReceipt({logs:j.result,status:"0x1",blockNumber:first.result.blockNumber});
   return {status:"ok",rpc:endpoint,from:filter.fromBlock,to:filter.toBlock,
    fetched_logs:j.result.length,matched_tx_logs:found.length,rn1_maker_logs:dec.rn1_as_maker,
    distinct_txhashes:new Set(j.result.map((x:any)=>x.transactionHash)).size};
  }catch(e){errors.push(String(e).slice(0,100))}
 }
 return {status:"unavailable",errors};
}
async function receiptBounds(){
 const rows=await db.unsafe(`(select transaction_hash,trade_at from pi.rn1_maker_historical_fills where role='maker' order by trade_at,fingerprint limit 1)
 union all
 (select transaction_hash,trade_at from pi.rn1_maker_historical_fills where role='maker' order by trade_at desc,fingerprint desc limit 1)`);
 const out:any[]=[];
 for(const r of rows){const got=await receipt(r.transaction_hash);out.push({txhash:r.transaction_hash,reported_at:r.trade_at,
 block:parseInt(got.result.blockNumber,16),rpc:got.endpoint})}
 return out;
}
Deno.serve(async req=>{
 if(req.method!=="POST")return response({error:"method"},405);
 if(!await authorized(req))return response({error:"unauthorized"},403);
 let body:any={};try{body=await req.json()}catch{}
 if(body.action==="rn1_chain_bounds"){try{return response({bounds:await receiptBounds()})}catch(e){return response({error:String(e).slice(0,150)},500)}}
 if(body.action==="rn1_order_logs_probe"){try{return response(await getLogsProbe(Number(body.span)||50))}catch(e){return response({error:String(e).slice(0,180)},500)}}
 if(body.action==="rn1_signed_order_match_tick"){
  const take=Math.max(1,Math.min(4,Number(body.limit)||2));
  const out:any[]=[];
  for(let i=0;i<take;i++){
   try{const one=await matchNextSignedOrder();out.push(one);if(one.status==="complete")break}
   catch(e){out.push({status:"error",error:String(e).slice(0,160)});break}
  }
  return response({results:out});
 }
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
