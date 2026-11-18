// RN1 Polygon acquisition auditor: bounded, idempotent, private and READ ONLY on-chain.
// Explicit scope: only the preselected pi.rn1_chain_acquisition_queue 8-market panel.
// Each row = (condition/market, transaction); fills in the same tx are aggregated.
// Critical: "verified" proves wallet collateral/position movement, NOT after-fee P&L.
import postgres from "npm:postgres@3.4.3";
import { id, Interface } from "npm:ethers@6.13.5";

const db = postgres(Deno.env.get("SUPABASE_DB_URL") || "", {
  max: 1, prepare: false, connect_timeout: 10,
});
const RPC = ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"];
const WALLET = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
const CTF = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
const PUSD = "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb";
const USDCE = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const ZERO32 = "0x" + "0".repeat(64);
const event = new Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
  "event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)",
]);
const ctf = new Interface([
  "function getCollectionId(bytes32 parentCollectionId,bytes32 conditionId,uint256 indexSet) view returns (bytes32)",
  "function getPositionId(address collateralToken,bytes32 collectionId) view returns (uint256)",
]);
const transferTopic = id("Transfer(address,address,uint256)").toLowerCase();
const singleTopic = id("TransferSingle(address,address,address,uint256,uint256)").toLowerCase();
const batchTopic = id("TransferBatch(address,address,address,uint256[],uint256[])").toLowerCase();
const feeTopic = id("FeePaid(address,address,uint256)").toLowerCase();
const micro = 1_000_000n;

function response(x:unknown,status=200) {
  return Response.json(x,{status,headers:{"Cache-Control":"no-store"}});
}
async function authorized(req:Request) {
  const token=req.headers.get("x-pi-scheduler-token")||"";
  if(!/^[0-9a-f]{64}$/.test(token)) return false;
  const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token));
  const hash=[...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,"0")).join("");
  const r=await db.unsafe("select 1 from pi.scheduler_auth where single_row_id=1 and token_sha256=$1",[hash]);
  return r.length===1;
}
function units(x:any):bigint {
  const s=String(x??"0").trim();
  if(!/^-?\d+(?:\.\d+)?$/.test(s)) throw Error("bad_source_decimal");
  const neg=s.startsWith("-"); const parts=(neg?s.slice(1):s).split(".");
  const frac=(parts[1]||"").padEnd(7,"0");
  let v=BigInt(parts[0])*micro+BigInt(frac.slice(0,6));
  if(frac[6]>="5")v++;
  return neg?-v:v;
}
function decimal(x:bigint):string {
  const neg=x<0n, a=neg?-x:x;
  return (neg?"-":"")+ (a/micro).toString()+"."+(a%micro).toString().padStart(6,"0");
}
function close(a:bigint,b:bigint):boolean { const d=a-b;return d<=2n&&d>=-2n; }
function addr(x:any):string {return String(x||"").toLowerCase();}
async function rpc(method:string,params:unknown[]):Promise<any> {
  let last="rpc_failed";
  for(const host of RPC) {
    try {
      const r=await fetch(host,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({jsonrpc:"2.0",id:1,method,params}),
        signal:AbortSignal.timeout(12000)});
      if(!r.ok){last="http_"+r.status;continue;}
      const data=await r.json();
      if(data.result!==undefined&&data.result!==null)return data.result;
      last=String(data.error?.message||"null_result").slice(0,150);
    }catch(e){last=String(e).slice(0,150);}
  }
  throw Error(last);
}
async function ctfCall(name:string,args:unknown[]):Promise<any> {
  const data=ctf.encodeFunctionData(name,args);
  const raw=await rpc("eth_call",[{to:CTF,data},"latest"]);
  return ctf.decodeFunctionResult(name,raw)[0];
}
async function tokenMap(market:string):Promise<{zero:string,one:string}> {
  const existing=await db.unsafe("select position_token0,position_token1 from pi.rn1_chain_token_map where market_key=$1",[market]);
  if(existing.length)return {zero:String(existing[0].position_token0),one:String(existing[0].position_token1)};
  const calculate=async(outcome:number):Promise<string>=>{
    const collection=await ctfCall("getCollectionId",[ZERO32,market,BigInt(1<<outcome)]);
    const position=await ctfCall("getPositionId",[USDCE,collection]);
    return BigInt(position).toString();
  };
  const [zero,one]=await Promise.all([calculate(0),calculate(1)]);
  if(zero===one)throw Error("duplicate_position_ids");
  await db.unsafe(`insert into pi.rn1_chain_token_map (market_key,position_token0,position_token1)
    values($1,$2,$3) on conflict(market_key) do nothing`,[market,zero,one]);
  return {zero,one};
}
type Queued={market_key:string;source_tx_hash:string;archived_cost:string;archived_shares:string;
 source_fill_count:number;source_outcomes:number[];audit_attempts:number};
async function claim(limit:number):Promise<Queued[]> {
  const r=await db.unsafe(`with next as (
    select market_key,source_tx_hash from pi.rn1_chain_acquisition_queue
    where audit_status='pending' and audit_attempts<3
      and (audit_lease_until is null or audit_lease_until<now())
    order by source_first_at,market_key,source_tx_hash
    for update skip locked limit $1
  ) update pi.rn1_chain_acquisition_queue q
  set audit_attempts=q.audit_attempts+1,
      audit_lease_until=now()+interval '3 minutes'
  from next n where q.market_key=n.market_key and q.source_tx_hash=n.source_tx_hash
  returning q.market_key,q.source_tx_hash,q.archived_cost::text,
    q.archived_shares::text,q.source_fill_count,q.source_outcomes,q.audit_attempts`,[limit]);
  return r as unknown as Queued[];
}
type Audit={status:"verified"|"ambiguous"|"mismatch";note:string;pusd_out:bigint;
 pusd_in:bigint;received:bigint;wallet_gas_payer:string;fee_count:number;evidence:unknown};
async function audit(row:Queued):Promise<Audit> {
  const hash=addr(row.source_tx_hash);
  if(!/^0x[0-9a-f]{64}$/.test(hash)||!/^0x[0-9a-f]{64}$/.test(row.market_key))throw Error("invalid_source_ids");
  const [receipt,tx]=await Promise.all([
    rpc("eth_getTransactionReceipt",[hash]),
    rpc("eth_getTransactionByHash",[hash]),
  ]);
  if(addr(receipt.transactionHash)!==hash||addr(tx.hash)!==hash ||
      Number(BigInt(receipt.status||"0x0"))!==1)throw Error("transaction_not_successful_or_hash_mismatch");
  const walletPusdOut:{to:string;micro:string;logIndex:number}[]=[];
  const walletPusdIn:{from:string;micro:string;logIndex:number}[]=[];
  const walletUsdce:{from:string;to:string;micro:string}[]=[];
  const walletPositions:{from:string;to:string;tokenId:string;micro:string;logIndex:number}[]=[];
  let feeCount=0;
  for(const log of receipt.logs||[]){
    const contract=addr(log.address),topic=addr(log.topics?.[0]);
    if(topic===feeTopic)feeCount++;
    if((contract===PUSD||contract===USDCE)&&topic===transferTopic) {
      const e=event.parseLog({topics:log.topics,data:log.data});
      if(!e)continue;
      const from=addr(e.args.from),to=addr(e.args.to),value=BigInt(e.args.value);
      const logIndex=Number(BigInt(log.logIndex||"0x0"));
      if(contract===PUSD){
        if(from===WALLET)walletPusdOut.push({to,micro:value.toString(),logIndex});
        if(to===WALLET)walletPusdIn.push({from,micro:value.toString(),logIndex});
      }else if(from===WALLET||to===WALLET){
        walletUsdce.push({from,to,micro:value.toString()});
      }
    }
    if(contract===CTF&&(topic===singleTopic||topic===batchTopic)) {
      const e=event.parseLog({topics:log.topics,data:log.data});
      if(!e)continue;
      const from=addr(e.args.from),to=addr(e.args.to);
      if(from!==WALLET&&to!==WALLET)continue;
      const ids:bigint[]=topic===singleTopic?[BigInt(e.args.id)]:[...e.args.ids].map((x:any)=>BigInt(x));
      const vals:bigint[]=topic===singleTopic?[BigInt(e.args.value)]:[...e.args[4]].map((x:any)=>BigInt(x));
      for(let i=0;i<ids.length;i++) walletPositions.push({
        from,to,tokenId:ids[i].toString(),micro:vals[i].toString(),
        logIndex:Number(BigInt(log.logIndex||"0x0"))
      });
    }
  }
  const cashOut=walletPusdOut.reduce((s,v)=>s+BigInt(v.micro),0n);
  const cashIn=walletPusdIn.reduce((s,v)=>s+BigInt(v.micro),0n);
  const expectedCash=units(row.archived_cost),expectedShares=units(row.archived_shares);
  if(!Array.isArray(row.source_outcomes)||row.source_outcomes.length!==1 ||
     ![0,1].includes(Number(row.source_outcomes[0])))throw Error("unsupported_multitoken_aggregation");
  const mapping=await tokenMap(row.market_key);
  const tokenId=Number(row.source_outcomes[0])===0?mapping.zero:mapping.one;
  const inbound=walletPositions.filter(v=>v.to===WALLET&&v.tokenId===tokenId)
    .reduce((s,v)=>s+BigInt(v.micro),0n);
  const outbound=walletPositions.filter(v=>v.from===WALLET&&v.tokenId===tokenId)
    .reduce((s,v)=>s+BigInt(v.micro),0n);
  const netShares=inbound-outbound;
  const unexpected=walletPositions.filter(v=>v.tokenId!==tokenId);
  const cashMatch=close(cashOut,expectedCash),sharesMatch=close(netShares,expectedShares);
  let status:Audit["status"]="ambiguous";
  if(cashMatch&&sharesMatch&&unexpected.length===0&&walletUsdce.length===0)status="verified";
  else if(cashOut===0n&&netShares===0n)status="mismatch";
  const note=status==="verified"?"exact_pusd_outflow_and_expected_ctf_net_inflow":
    status==="mismatch"?"no_matching_wallet_cash_or_ctf_movements":
      "partial_or_batched_transfer_needs_manual_attribution";
  const evidence={
    rpc_evidence:"eth_getTransactionReceipt + eth_getTransactionByHash + CTF contract eth_call",
    txhash:hash,market_key:row.market_key,source_fill_count:row.source_fill_count,
    source_outcomes:row.source_outcomes,expected_token_id:tokenId,
    block_number:Number(BigInt(receipt.blockNumber||"0x0")),
    wallet_gas_payer:addr(tx.from)===WALLET,gas_payer:addr(tx.from),
    tx_gas_wei:(BigInt(receipt.gasUsed||"0x0")*BigInt(receipt.effectiveGasPrice||tx.gasPrice||"0x0")).toString(),
    expected_pusd_debit:decimal(expectedCash),observed_pusd_debit:decimal(cashOut),
    observed_pusd_credit:decimal(cashIn),
    expected_share_receipt:decimal(expectedShares),observed_expected_token_net:decimal(netShares),
    expected_token_inbound:decimal(inbound),expected_token_outbound:decimal(outbound),
    cash_match:cashMatch,shares_match:sharesMatch,
    wallet_pusd_out_transfers:walletPusdOut,wallet_pusd_in_transfers:walletPusdIn,
    wallet_erc1155_transfers:walletPositions,wallet_usdce_transfers:walletUsdce,
    receipt_fee_topic_count:feeCount,
    fee_caveat:"FeePaid logs can concern other users; no rebates/gas allocation or net PnL inferred.",
  };
  return {status,note,pusd_out:cashOut,pusd_in:cashIn,received:netShares,
    wallet_gas_payer:addr(tx.from),fee_count:feeCount,evidence};
}
async function save(row:Queued,r:Audit) {
  await db.unsafe(`update pi.rn1_chain_acquisition_queue set
    audit_status=$3, observed_pusd_debit=$4::numeric,
    observed_wallet_pusd_out=$4::numeric,observed_wallet_pusd_in=$5::numeric,
    observed_shares_received=$6::numeric, observed_gas_payer=$7,
    observed_fee_log_count=$8, audit_note=$9,
    audit_evidence=($10::jsonb #>> '{}')::jsonb,audit_lease_until=null,last_checked_at=now()
    where market_key=$1 and source_tx_hash=$2`,[
     row.market_key,row.source_tx_hash,r.status,decimal(r.pusd_out),decimal(r.pusd_in),
     decimal(r.received),r.wallet_gas_payer,r.fee_count,r.note,JSON.stringify(r.evidence)
    ]);
}
async function saveFailure(row:Queued,error:unknown) {
  const note=String(error).slice(0,240);
  const final=row.audit_attempts>=3;
  await db.unsafe(`update pi.rn1_chain_acquisition_queue set
     audit_status=$3,audit_note=$4,last_checked_at=now(),
     audit_lease_until=case when $5::boolean then null else now()+interval '2 minutes' end
     where market_key=$1 and source_tx_hash=$2`,
    [row.market_key,row.source_tx_hash,final?"error":"pending",note,final]);
}
Deno.serve(async (req:Request)=>{
  try{
    if(req.method!=="POST")return response({error:"method_not_allowed"},405);
    if(!await authorized(req))return response({error:"unauthorized"},401);
    const body=await req.json();
    if(body?.action!=="acquisition_batch")return response({error:"unsupported_action"},400);
    const limit=Math.min(2,Math.max(1,Math.trunc(Number(body.limit||1))));
    const claimed=await claim(limit);
    const results=[];
    for(const item of claimed){
      try{
        const r=await audit(item);await save(item,r);
        results.push({market_key:item.market_key,txhash:item.source_tx_hash,status:r.status,
          expected_pusd_debit:item.archived_cost,observed_pusd_debit:decimal(r.pusd_out),
          received_expected_token:decimal(r.received),fee_topic_count:r.fee_count});
      }catch(e){
        await saveFailure(item,e);
        results.push({market_key:item.market_key,txhash:item.source_tx_hash,
          status:item.audit_attempts>=3?"error":"retry",error:String(e).slice(0,140)});
      }
    }
    return response({status:"processed",count:results.length,results,
      warning:"Maker rebates, exchange fees and net PnL are NOT inferred."});
  }catch(e){return response({error:String(e).slice(0,180)},500);}
});
