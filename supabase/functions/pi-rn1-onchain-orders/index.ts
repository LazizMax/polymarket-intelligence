// Read-only Polygon OrderFilled receipt probe. Scheduler-authenticated, bounded to
// archived RN1 transaction hashes. No private wallet credentials or paid RPC.
import postgres from "npm:postgres@3.4.3";
import { Interface, TypedDataEncoder } from "npm:ethers@6.13.5";
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
function parseReceipt(x:any,eventLimit=12){
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
  events.push({transaction_hash:String(e.transactionHash||'').toLowerCase(),order_hash:orderHash,maker,taker,v2,contract:address,token_id:tokenId,
   log_index:e.logIndex,side,price,shares});
 }
 return {block_number:x.blockNumber,tx_status:x.status,logs:logs.length,order_filled_logs:events.length,
  rn1_as_maker:events.filter(e=>e.maker===wallet).length,
  rn1_as_taker:events.filter(e=>e.taker===wallet).length,
  order_events:events.filter(e=>e.maker===wallet||e.taker===wallet).slice(0,eventLimit)};
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
async function fetchMakerLogs(from:bigint,to:bigint){
 const filter={address:["0xe111180000d2663c0091e4f400237545b87b996b",
 "0xe2222d279d744050d28e00520010520000310f59"],
 fromBlock:"0x"+from.toString(16),toBlock:"0x"+to.toString(16),
 topics:[topicV2,null,"0x"+wallet.slice(2).padStart(64,"0")]};
 let last="rpc_unavailable";
 for(const endpoint of rpcEndpoints){
  try{
   const r=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},
     body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_getLogs",params:[filter]}),
     signal:AbortSignal.timeout(30000)});
   if(!r.ok){last="HTTP "+r.status;continue}
   const j=await r.json();
   if(j.error){last="RPC "+String(j.error.message||j.error.code).slice(0,120);continue}
   if(!Array.isArray(j.result))throw Error("Malformed RPC logs");
   if(j.result.length>10000)throw Error("Excessive logs; refuse processing");
   return {logs:j.result,endpoint};
  }catch(e){last=String(e).slice(0,120)}
 }
 throw Error(last);
}
async function scanMakerLogChunk(){
 const claim=await db.unsafe(`update pi.rn1_maker_chain_scan_state
 set lease_until=now()+interval '110 seconds',updated_at=now()
 where singleton=true and status='running'
  and (lease_until is null or lease_until<now())
 returning next_block,to_block,chunk_size`);
 if(!claim.length)return {status:"idle_or_complete"};
 const job=claim[0],first=BigInt(job.next_block),last=BigInt(job.to_block);
 try{
  const cap=await db.unsafe("select pg_database_size(current_database())::bigint bytes");
  if(Number(cap[0].bytes)>900000000){
   await db.unsafe("update pi.rn1_maker_chain_scan_state set status='paused_quota',lease_until=null,last_error='Database safety budget' where singleton=true");
   return {status:"paused_quota"};
  }
  const end=first+BigInt(job.chunk_size)-1n<=last?first+BigInt(job.chunk_size)-1n:last;
  const {logs,endpoint}=await fetchMakerLogs(first,end);
  const parsed=parseReceipt({logs,status:"0x1",blockNumber:"0x"+end.toString(16)},100000);
  const makerEvents=parsed.order_events.filter((e:any)=>e.maker===wallet&&e.v2&&e.side===0&&/^0x[0-9a-f]{64}$/.test(e.transaction_hash));
  const byTx=new Map<string,any[]>();
  for(const e of makerEvents){const a=byTx.get(e.transaction_hash)||[];a.push(e);byTx.set(e.transaction_hash,a)}
  const txIds=[...byTx.keys()];
  const source=txIds.length?await db.unsafe(`select f.fingerprint,f.transaction_hash,f.token_id,
   f.price::text price,f.shares::text shares from pi.rn1_maker_historical_fills f
   join jsonb_array_elements_text(($1::text)::jsonb) ids(txhash) on f.transaction_hash=ids.txhash
   where f.role='maker' and not exists(
      select 1 from pi.rn1_maker_onchain_tx_audit a where a.transaction_hash=f.transaction_hash)
   order by f.transaction_hash,f.fingerprint`,[JSON.stringify(txIds)]):[];
  const sources=new Map<string,any[]>();
  for(const f of source){const a=sources.get(f.transaction_hash)||[];a.push(f);sources.set(f.transaction_hash,a)}
  const mappings:any[]=[], audits:any[]=[];
  let confirmedTx=0,rejectedTx=0;
  for(const [txhash,fills] of sources){
   const events=byTx.get(txhash)||[];
   let verdict="confirmed",note="",matched:any[]=[];
   if(events.length!==fills.length){verdict="unmatched";note="Source/onchain Maker count mismatch"}
   else{
    const used=new Set<number>();
    for(const f of fills){
     const price=Number(f.price),shares=Number(f.shares);
     const candidates=events.map((e:any,i:number)=>({e,i})).filter(({e,i})=>
       !used.has(i)&&e.token_id===f.token_id
       &&Number.isFinite(e.price)&&Math.abs(e.price-price)<=0.000002
       &&Number.isFinite(e.shares)&&Math.abs(e.shares-shares)<=Math.max(0.000002,shares*0.00000001));
     if(candidates.length!==1){verdict=candidates.length>1?"ambiguous":"unmatched";note="Price/size/token mapping not unique";break}
     const {e,i}=candidates[0];used.add(i);
     if(!/^0x[0-9a-f]{64}$/.test(e.order_hash)){verdict="unmatched";note="Invalid order hash";break}
     matched.push({fingerprint:f.fingerprint,order_hash:e.order_hash,log_index:Number(BigInt(e.log_index))});
    }
   }
   if(verdict==="confirmed"&&matched.length!==fills.length){verdict="unmatched";note="Incomplete matching"}
   if(verdict==="confirmed"){mappings.push(...matched);confirmedTx++}else rejectedTx++;
   audits.push({transaction_hash:txhash,source_fills:fills.length,maker_logs:events.length,
     matched_fills:verdict==="confirmed"?matched.length:0,status:verdict,
     block_number:null,rpc_provider:endpoint,note:note||null});
  }
  await db.begin(async tx=>{
   if(mappings.length){
    const updated=await tx.unsafe(`update pi.rn1_maker_historical_fills f
      set maker_order_hash=x.order_hash,maker_order_log_index=x.log_index
      from jsonb_to_recordset(($1::text)::jsonb) as x(fingerprint text,order_hash text,log_index integer)
      where f.fingerprint=x.fingerprint and f.maker_order_hash is null
       returning f.fingerprint`,[JSON.stringify(mappings)]);
    if(updated.length!==mappings.length)throw Error("Mismatch applying uniquely matched OrderFilled events");
   }
   if(audits.length)await tx.unsafe(`insert into pi.rn1_maker_onchain_tx_audit
    (transaction_hash,source_fills,maker_logs,matched_fills,status,block_number,rpc_provider,note)
    select transaction_hash,source_fills,maker_logs,matched_fills,status,block_number,rpc_provider,note
    from jsonb_to_recordset(($1::text)::jsonb) as x(
      transaction_hash text,source_fills integer,maker_logs integer,matched_fills integer,
      status text,block_number bigint,rpc_provider text,note text)
    on conflict(transaction_hash) do nothing`,[JSON.stringify(audits)]);
   const advanced=await tx.unsafe(`update pi.rn1_maker_chain_scan_state set
    next_block=$1,chunk_size=chunk_size,chunks_done=chunks_done+1,
    chain_logs_seen=chain_logs_seen+$2,fills_verified=fills_verified+$3,
    tx_confirmed=tx_confirmed+$4,tx_unmatched=tx_unmatched+$5,
    status=case when $1>to_block then 'complete' else 'running' end,
    lease_until=null,error_attempts=0,last_success_at=now(),last_error=null,updated_at=now()
    where singleton=true and next_block=$6 and status='running' returning next_block`,
    [Number(end+1n),logs.length,mappings.length,confirmedTx,rejectedTx,Number(first)]);
   if(advanced.length!==1)throw Error("Chain scan checkpoint race");
  });
  return {status:end===last?"complete":"running",from:Number(first),to:Number(end),
   order_logs:makerEvents.length,unique_transactions:txIds.length,
   source_transactions:sources.size,confirmed_transactions:confirmedTx,
   unmatched_transactions:rejectedTx,confirmed_fills:mappings.length};
 }catch(e){
  const msg=String(e).slice(0,180);
  const retrySmaller=/HTTP 400|HTTP 413|too many|response size|query returned more|range limit|RPC -32005/i.test(msg)
    && Number(job.chunk_size)>100;
  const rows=await db.unsafe(`update pi.rn1_maker_chain_scan_state
   set lease_until=null,last_error=$1,
     chunk_size=case when $2 then greatest(100,chunk_size/2) else chunk_size end,
     error_attempts=case when $2 then 0 else error_attempts+1 end,
     status=case when not $2 and error_attempts+1>=5 then 'paused_error' else status end,
     updated_at=now()
   where singleton=true and next_block=$3 returning chunk_size,status`,
   [msg,retrySmaller,Number(first)]);
  return {status:retrySmaller?"retry_smaller_chunk":"error",error:msg,
    block:Number(first),next_chunk_size:rows[0]?.chunk_size};
 }
}
async function inspectAmbiguousTransactions(){
 const rows=await db.unsafe(`select transaction_hash,source_fills,maker_logs,note
   from pi.rn1_maker_onchain_tx_audit where status='ambiguous'
   order by verified_at limit 8`);
 const results:any[]=[];
 for(const audit of rows){
  const fills=await db.unsafe(`select fingerprint,token_id,price::text price,shares::text shares
    from pi.rn1_maker_historical_fills where transaction_hash=$1 and role='maker'
    order by fingerprint`,[audit.transaction_hash]);
  try{
   const r=await receipt(audit.transaction_hash);
   const events=parseReceipt(r.result,100).order_events.filter((e:any)=>e.maker===wallet && e.v2 && e.side===0);
   const edgeSets=fills.map((f:any)=>({
     fingerprint:f.fingerprint,price:f.price,shares:f.shares,
     candidates:events.filter((e:any)=>e.token_id===f.token_id
       &&Math.abs(Number(f.price)-Number(e.price))<=0.000002
       &&Math.abs(Number(f.shares)-Number(e.shares))<=Math.max(0.000002,Number(f.shares)*1e-8))
       .map((e:any)=>({order_hash:e.order_hash,log_index:e.log_index}))
   }));
   results.push({transaction_hash:audit.transaction_hash,source_fills:fills.length,
      events:events.map((e:any)=>({order_hash:e.order_hash,token_id:e.token_id,price:e.price,shares:e.shares,log_index:e.log_index})),
      source_candidates:edgeSets});
  }catch(e){results.push({transaction_hash:audit.transaction_hash,error:String(e).slice(0,140)})}
 }
 return {ambiguous:results};
}
async function preserveAmbiguousOrderEvents(){
 const audits=await db.unsafe(`select transaction_hash from pi.rn1_maker_onchain_tx_audit a
 where status='ambiguous' and not exists(
 select 1 from pi.rn1_maker_ambiguous_order_events ev where ev.transaction_hash=a.transaction_hash)
 order by verified_at limit 8`);
 const outcomes:any[]=[];
 for(const item of audits){
  const txhash=String(item.transaction_hash);
  const fills=await db.unsafe(`select token_id,price::text price,shares::text shares from
    pi.rn1_maker_historical_fills where role='maker' and transaction_hash=$1`,[txhash]);
  const fetched=await receipt(txhash);
  const p=parseReceipt(fetched.result,200);
  const events=p.order_events.filter((e:any)=>e.maker===wallet&&e.v2&&e.side===0);
  // Verify equality of complete multisets (token, price, quantity) before
  // preserving on-chain order evidence without fill-level identity.
  if(events.length!==fills.length){outcomes.push({txhash,status:"rejected_count"});continue}
  const unmatched=[...events];
  let valid=true;
  for(const fill of fills){
   const i=unmatched.findIndex((e:any)=>e.token_id===fill.token_id &&
     Number.isFinite(e.price)&&Math.abs(e.price-Number(fill.price))<=.000002 &&
     Number.isFinite(e.shares)&&Math.abs(e.shares-Number(fill.shares))<=Math.max(.000002,Number(fill.shares)*1e-8));
   if(i<0){valid=false;break}
   unmatched.splice(i,1);
  }
  if(!valid||unmatched.length){outcomes.push({txhash,status:"rejected_value"});continue}
  const rows=events.map((e:any)=>({transaction_hash:txhash,log_index:Number(BigInt(e.log_index)),
    order_hash:e.order_hash,token_id:e.token_id,
    execution_price:e.price,filled_shares:e.shares}));
  if(rows.some((e:any)=>!/^0x[0-9a-f]{64}$/.test(e.order_hash)||!Number.isInteger(e.log_index))){outcomes.push({txhash,status:"rejected_event"});continue}
  await db.begin(async txn=>{
    const saved=await txn.unsafe(`insert into pi.rn1_maker_ambiguous_order_events
    (transaction_hash,log_index,order_hash,token_id,execution_price,filled_shares)
    select transaction_hash,log_index,order_hash,token_id,execution_price,filled_shares
    from jsonb_to_recordset(($1::text)::jsonb) as x(
    transaction_hash text,log_index integer,order_hash text,token_id text,
    execution_price numeric,filled_shares numeric) on conflict(transaction_hash,log_index) do nothing
    returning log_index`,[JSON.stringify(rows)]);
    if(saved.length!==rows.length)throw Error("Ambiguous onchain order audit upsert mismatch");
  });
  outcomes.push({txhash,status:"onchain_orders_preserved_without_fill_mapping",orders:rows.length});
 }
 return {results:outcomes};
}
const matchAbi=new Interface(["function matchOrders(bytes32 conditionId,(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder,bytes signature) takerOrder,(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder,bytes signature)[] makerOrders,uint256 takerFillAmount,uint256[] makerFillAmounts,uint256 takerFeeAmount,uint256[] makerFeeAmounts)"]);
async function decodeSignedMakerOrderProbe(){
 const txs=await db.unsafe(`select transaction_hash,verified_fills,first_fill_at
    from (select transaction_hash,count(*) verified_fills,min(trade_at) first_fill_at
      from pi.rn1_maker_historical_fills where role='maker' and maker_order_hash is not null
      group by transaction_hash) t
    order by verified_fills desc,first_fill_at desc limit 4`);
 const results:any[]=[];
 for(const t of txs){
  let r:any=null,provider="";
  for(const endpoint of rpcEndpoints){
   try{
    const reply=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_getTransactionByHash",params:[t.transaction_hash]}),
      signal:AbortSignal.timeout(12000)});
    if(!reply.ok)continue;const v=await reply.json();
    if(v.result){r=v.result;provider=endpoint;break}
   }catch{}
  }
  if(!r){results.push({transaction_hash:t.transaction_hash,status:"rpc_unavailable"});continue}
  const raw=String(r.input||r.data||"");
  let parsed:any=null,error="";
  try{parsed=matchAbi.parseTransaction({data:raw})}catch(e){error=String(e).slice(0,140)}
  const maker=parsed?.args?.makerOrders||[];
  const onlyRn1=[...maker].filter((o:any)=>String(o.maker).toLowerCase()===wallet);
  const receiptData=await receipt(String(t.transaction_hash));
  const onchainOrders=parseReceipt(receiptData.result,1000).order_events.filter((e:any)=>e.maker===wallet).map((e:any)=>String(e.order_hash).toLowerCase());
  const typedData={Order:[
   {name:"salt",type:"uint256"},{name:"maker",type:"address"},{name:"signer",type:"address"},
   {name:"tokenId",type:"uint256"},{name:"makerAmount",type:"uint256"},{name:"takerAmount",type:"uint256"},
   {name:"side",type:"uint8"},{name:"signatureType",type:"uint8"},{name:"timestamp",type:"uint256"},
   {name:"metadata",type:"bytes32"},{name:"builder",type:"bytes32"}]};
  const domain={name:"Polymarket CTF Exchange",version:"2",chainId:137,verifyingContract:r.to};
  const signedHashes=onlyRn1.map((o:any)=>TypedDataEncoder.hash(domain,typedData,{
   salt:o.salt,maker:o.maker,signer:o.signer,tokenId:o.tokenId,makerAmount:o.makerAmount,
   takerAmount:o.takerAmount,side:o.side,signatureType:o.signatureType,timestamp:o.timestamp,
   metadata:o.metadata,builder:o.builder
  }).toLowerCase());
  const hashMatches=signedHashes.filter((h:string)=>onchainOrders.includes(h)).length;
  results.push({transaction_hash:t.transaction_hash,rpc:provider,to:r.to,
    selector:raw.slice(0,10),calldata_bytes:raw.length/2-1,
    decoded:!!parsed,decoding_error:error,
    maker_orders_all:maker.length,maker_orders_rn1:onlyRn1.length,hash_matches:hashMatches,
    receipt_maker_hashes:onchainOrders.length,
    samples:onlyRn1.slice(0,6).map((o:any)=>({
      salt:o.salt.toString(),maker:String(o.maker).toLowerCase(),token_id:o.tokenId.toString(),
      maker_amount:o.makerAmount.toString(),taker_amount:o.takerAmount.toString(),
      timestamp:o.timestamp.toString(),side:Number(o.side),signature_type:Number(o.signatureType),
      price:Number(o.makerAmount)/Number(o.takerAmount),signature_bytes:String(o.signature).length/2-1
    }))});
 }
 return {results};
}
const eipOrderTypes={Order:[
 {name:"salt",type:"uint256"},{name:"maker",type:"address"},{name:"signer",type:"address"},
 {name:"tokenId",type:"uint256"},{name:"makerAmount",type:"uint256"},{name:"takerAmount",type:"uint256"},
 {name:"side",type:"uint8"},{name:"signatureType",type:"uint8"},{name:"timestamp",type:"uint256"},
 {name:"metadata",type:"bytes32"},{name:"builder",type:"bytes32"}]};
async function fetchPolygonTransaction(txhash:string){
 let last="rpc_unavailable";
 for(const endpoint of rpcEndpoints){
  try{
   const r=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_getTransactionByHash",params:[txhash]}),
    signal:AbortSignal.timeout(12000)});
   if(!r.ok){last="rpc_http_"+r.status;continue}
   const j=await r.json();
   if(j.result)return {transaction:j.result,endpoint};
   last=j.error?"rpc_error_"+String(j.error.message||j.error.code).slice(0,90):"rpc_tx_not_found";
  }catch(e){last="rpc_network_"+String(e).slice(0,80)}
 }
 throw Error(last);
}
async function sampleSignedOrderCalldataOne(){
 const lease=await db.unsafe(`update pi.rn1_maker_calldata_sample_txs s
 set lease_until=now()+interval '60 seconds',last_attempt_at=now()
 where s.transaction_hash=(
  select transaction_hash from pi.rn1_maker_calldata_sample_txs
  where (status='pending' or (status='error' and error_attempts<3))
    and (lease_until is null or lease_until<now())
  order by priority,md5(transaction_hash||':calldata-randomized-order-v1') limit 1 for update skip locked)
 returning s.transaction_hash,s.cohort,s.status`);
 if(!lease.length)return {status:"no_pending"};
 const t=lease[0],hash=String(t.transaction_hash);
 try{
  const dbsize=await db.unsafe("select pg_database_size(current_database())::bigint bytes");
  if(Number(dbsize[0].bytes)>875000000)return {status:"paused_storage_budget"};
  const {transaction:raw}=await fetchPolygonTransaction(hash);
  const to=String(raw.to||"").toLowerCase();
  if(!exchanges.has(to))throw Error("tx_to_unexpected_exchange");
  const data=String(raw.input||raw.data||"");
  const parsed=matchAbi.parseTransaction({data});
  if(!parsed||parsed.name!=="matchOrders")throw Error("unsupported_transaction_selector");
  const makerOrders=[...(parsed.args.makerOrders||[])].filter((o:any)=>String(o.maker).toLowerCase()===wallet);
  const dbMatches=await db.unsafe(`select maker_order_hash order_hash,min(token_id) token_id,
   min(price)::float8 min_price,max(price)::float8 max_price,sum(shares)::numeric total_filled
   from pi.rn1_maker_historical_fills where transaction_hash=$1 and role='maker'
   group by maker_order_hash`,[hash]);
  const expected=new Map<string,any>(dbMatches.map((x:any)=>[String(x.order_hash).toLowerCase(),x]));
  if(!expected.size||!makerOrders.length)throw Error("no_source_maker_orders");
  const domain={name:"Polymarket CTF Exchange",version:"2",chainId:137,verifyingContract:to};
  const signed:any[]=[],matched=new Set<string>();
  for(const o of makerOrders){
   const h=TypedDataEncoder.hash(domain,eipOrderTypes,{
    salt:o.salt,maker:o.maker,signer:o.signer,tokenId:o.tokenId,
    makerAmount:o.makerAmount,takerAmount:o.takerAmount,
    side:o.side,signatureType:o.signatureType,timestamp:o.timestamp,
    metadata:o.metadata,builder:o.builder
   }).toLowerCase();
   if(!expected.has(h))continue;
   const found=expected.get(h);
   if(matched.has(h))throw Error("duplicate_signed_hash_in_calldata");
   const amount=BigInt(o.makerAmount),qty=BigInt(o.takerAmount),created=BigInt(o.timestamp);
   if(Number(o.side)!==0||qty<=0n||amount<=0n)throw Error("wrong_side_or_amount");
   if(String(o.tokenId)!==String(found.token_id))throw Error("token_mismatch");
   if(created<1600000000000n||created>1900000000000n)throw Error("creation_timestamp_outside_bounds");
   const p=Number(amount)/Number(qty);
   if(!Number.isFinite(p)||Math.abs(p-Number(found.min_price))>.002||
    Math.abs(p-Number(found.max_price))>.002)throw Error("signed_price_not_corresponding_to_execution");
   if(Number(found.total_filled)>Number(qty)/1e6+0.00002)
    throw Error("executions_exceed_signed_quantity");
   matched.add(h);
   signed.push({order_hash:h,source_transaction_hash:hash,
    declared_created_ms:Number(created),token_id:String(o.tokenId),
    signed_buy_amount:amount.toString(),signed_receive_shares:qty.toString(),
    signed_price:p,salt:o.salt.toString(),signer:String(o.signer).toLowerCase(),
    signature_type:Number(o.signatureType),builder:String(o.builder).toLowerCase(),
    metadata:String(o.metadata).toLowerCase(),sampled_cohort:t.cohort,
    cryptographic_match:true});
  }
  if(matched.size!==expected.size)throw Error("calldata_source_hashes_not_equal");
  await db.begin(async txn=>{
   await txn.unsafe(`insert into pi.rn1_maker_calldata_signed_orders
   (order_hash,source_transaction_hash,declared_created_ms,token_id,signed_buy_amount,
    signed_receive_shares,signed_price,salt,signer,signature_type,builder,metadata,
    sampled_cohort,cryptographic_match)
   select order_hash,source_transaction_hash,declared_created_ms,token_id,signed_buy_amount,
    signed_receive_shares,signed_price,salt,signer,signature_type,builder,metadata,
    sampled_cohort,cryptographic_match
   from jsonb_to_recordset(($1::text)::jsonb) as v(
    order_hash text,source_transaction_hash text,declared_created_ms bigint,
    token_id text,signed_buy_amount numeric,signed_receive_shares numeric,signed_price numeric,
    salt numeric,signer text,signature_type smallint,builder text,metadata text,
    sampled_cohort text,cryptographic_match boolean)
   on conflict(order_hash) do nothing`,[JSON.stringify(signed)]);
   const changed=await txn.unsafe(`update pi.rn1_maker_calldata_sample_txs
   set status='confirmed',matched_orders=$2,lease_until=null,
    verified_at=now(),error_message=null
   where transaction_hash=$1 and lease_until>now()
   returning transaction_hash`,[hash,signed.length]);
   if(changed.length!==1)throw Error("sample_lease_lost");
  });
  return {status:"confirmed",cohort:t.cohort,transaction_hash:hash,matched_orders:signed.length};
 }catch(e){
  const msg=String(e).slice(0,170),unsupported=/unsupported|unexpected_exchange/.test(msg);
  await db.unsafe(`update pi.rn1_maker_calldata_sample_txs set
   status=case when $2 then 'unsupported' else 'error' end,
   error_attempts=error_attempts+1,error_message=$3,lease_until=null
   where transaction_hash=$1`,[hash,unsupported,msg]);
  return {status:unsupported?"unsupported":"error",error:msg,transaction_hash:hash};
 }
}
async function probeHistoricalPriceAtSigning(){
 const samples=await db.unsafe(`with c as (
 select token_id,order_hash,declared_created_ms,
 case when declared_created_ms <1794412800000 then 'earlier' else 'recent' end period
 from pi.rn1_maker_calldata_signed_orders where sampled_cohort='random_tx'
 )
 (select * from c where period='earlier' order by md5(order_hash) limit 4)
 union all
 (select * from c where period='recent' order by md5(order_hash) limit 4)`);
 const out:any[]=[];
 for(const s of samples){
  const at=Math.floor(Number(s.declared_created_ms)/1000);
  const query=new URLSearchParams({market:String(s.token_id),startTs:String(at-600),endTs:String(at+30),fidelity:"1"});
  const url="https://clob.polymarket.com/prices-history?"+query.toString();
  try{
   const response=await fetch(url,{method:"GET",signal:AbortSignal.timeout(12000)});
   const raw=await response.text();
   let j:any={};try{j=JSON.parse(raw)}catch{}
   const h=Array.isArray(j.history)?j.history:[];
   const pre=h.filter((p:any)=>Number(p.t)<=at && Number.isFinite(Number(p.p)));
   const most=pre.sort((a:any,b:any)=>Number(b.t)-Number(a.t))[0];
   out.push({sample_period:s.period,signing_timestamp_s:at,http_status:response.status,
    points:h.length,pre_points:pre.length,nearest_pre_age_seconds:most?at-Number(most.t):null,
    nearest_pre_price:most?Number(most.p):null,
    min_ts:h.length?Math.min(...h.map((p:any)=>Number(p.t))):null,
    max_ts:h.length?Math.max(...h.map((p:any)=>Number(p.t))):null,
    api_error:response.ok?null:raw.slice(0,120)});
  }catch(e){out.push({sample_period:s.period,signing_timestamp_s:at,error:String(e).slice(0,110)})}
 }
 return {probe_results:out};
}
Deno.serve(async req=>{
 if(req.method!=="POST")return response({error:"method"},405);
 if(!await authorized(req))return response({error:"unauthorized"},403);
 let body:any={};try{body=await req.json()}catch{}
 if(body.action==="rn1_preserve_ambiguous_orders"){try{return response(await preserveAmbiguousOrderEvents())}catch(e){return response({error:String(e).slice(0,200)},500)}}
 if(body.action==="rn1_inspect_ambiguous"){try{return response(await inspectAmbiguousTransactions())}catch(e){return response({error:String(e).slice(0,150)},500)}}
 if(body.action==="rn1_price_at_signing_probe"){try{return response(await probeHistoricalPriceAtSigning())}catch(e){return response({error:String(e).slice(0,180)},500)}}
 if(body.action==="rn1_calldata_sample_tick"){
  const count=Math.max(1,Math.min(8,Number(body.count)||4));
  const results:any[]=[];
  for(let i=0;i<count;i++){
   const r=await sampleSignedOrderCalldataOne();results.push(r);
   if(r.status==="no_pending"||r.status==="paused_storage_budget")break;
  }
  return response({results});
 }
 if(body.action==="rn1_signed_order_calldata_probe"){try{return response(await decodeSignedMakerOrderProbe())}catch(e){return response({error:String(e).slice(0,180)},500)}}
 if(body.action==="rn1_chain_scan_tick"){
   const count=Math.max(1,Math.min(3,Number(body.chunks)||1));
   const out=[];for(let i=0;i<count;i++){const x=await scanMakerLogChunk();out.push(x);if(x.status!=="running")break}
   return response({results:out});
 }
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
