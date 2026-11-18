// RN1 Polygon receipt forensic diagnostic. Intentionally READ ONLY.
// Only uses immutable, prespecified private chronological ledgers; no arbitrary
// transaction hash injection. Reports fee/gas payer and ERC1155 movement evidence.
import postgres from "npm:postgres@3.4.3";
import { id, Interface } from "npm:ethers@6.13.5";
const db=postgres(Deno.env.get("SUPABASE_DB_URL")||"",{max:1,prepare:false,connect_timeout:10});
const RPC=["https://polygon-bor-rpc.publicnode.com","https://polygon.drpc.org"];
const WALLET="0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
const CTF="0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
const TOPICS={
 transferSingle:id("TransferSingle(address,address,address,uint256,uint256)").toLowerCase(),
 transferBatch:id("TransferBatch(address,address,address,uint256[],uint256[])").toLowerCase(),
 positionSplit:id("PositionSplit(address,address,bytes32,bytes32,uint256[],uint256)").toLowerCase(),
 positionsMerge:id("PositionsMerge(address,address,bytes32,bytes32,uint256[],uint256)").toLowerCase(),
 payoutRedemption:id("PayoutRedemption(address,address,bytes32,uint256[],uint256)").toLowerCase(),
 transfer:id("Transfer(address,address,uint256)").toLowerCase(),
 feePaid:id("FeePaid(address,address,uint256)").toLowerCase()
};
function resp(data:any,status=200){return Response.json(data,{status,headers:{"Cache-Control":"no-store"}})}
async function authorized(req:Request){
 const token=req.headers.get("x-pi-scheduler-token")||"";
 if(!/^[0-9a-f]{64}$/.test(token))return false;
 const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token));
 const hex=[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,"0")).join("");
 return (await db.unsafe("select 1 from pi.scheduler_auth where single_row_id=1 and token_sha256=$1",[hex])).length===1;
}
async function rpc(method:string,params:any[]){
 let last="rpc_failed";
 for(const url of RPC){
  try{
   const r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},
     body:JSON.stringify({jsonrpc:"2.0",id:1,method,params}),signal:AbortSignal.timeout(15000)});
   if(!r.ok){last="HTTP_"+r.status;continue}
   const j=await r.json();if(j.result)return j.result;
   last=String(j.error?.message||"no_result").slice(0,100);
  }catch(e){last=String(e).slice(0,100)}
 }
 throw Error(last);
}
async function probe(market:string,kind:string){
 if(!/^0x[0-9a-f]{64}$/.test(market)||!["TRADE","MERGE","REDEEM"].includes(kind))throw Error("Invalid selected market/kind");
 const rows=await db.unsafe(`select timeline from pi.rn1_ledger_holdout_audit where market_key=$1
 union all select timeline from pi.rn1_ledger_pilot_audit where market_key=$1`,[market]);
 if(rows.length!==1)throw Error("Only pre-audited markets");
 const events=rows[0].timeline.filter((x:any)=>String(x.kind)===kind);
 if(!events.length)throw Error("No such event for market");
 const txhash=String(events[0].tx||"").toLowerCase();
 if(!/^0x[0-9a-f]{64}$/.test(txhash))throw Error("Bad archived tx");
 const [receipt,tx]=await Promise.all([rpc("eth_getTransactionReceipt",[txhash]),rpc("eth_getTransactionByHash",[txhash])]);
 if(String(receipt.transactionHash).toLowerCase()!==txhash)throw Error("receipt hash mismatch");
 const grouped=new Map<string,{contract:string,topic0:string,n:number,example_topics:string[],example_data:string}>();
 let total=0,ctf=0;
 for(const log of receipt.logs||[]){
  total++;
  const a=String(log.address||"").toLowerCase();
  const t0=String(log.topics?.[0]||"").toLowerCase();
  if(a===CTF)ctf++;
  const k=a+"|"+t0;
  const g=grouped.get(k)||{contract:a,topic0:t0,n:0,example_topics:[],example_data:""};
  g.n++;
  if(g.n===1){
   g.example_topics=(log.topics||[]).map((t:string)=>String(t).slice(0,70)).slice(0,4);
   g.example_data=String(log.data||"").slice(0,180);
  }
  grouped.set(k,g);
 }
 const gasUsed=BigInt(receipt.gasUsed||"0x0");
 const gasPrice=BigInt(receipt.effectiveGasPrice||tx.gasPrice||"0x0");
 return {status:"receipt_verified",market,kind,txhash,archived_event_count:events.length,
  block_number:Number(BigInt(receipt.blockNumber)),transaction_status:Number(BigInt(receipt.status||"0x0")),
  tx_from:String(tx.from||"").toLowerCase(),tx_to:String(tx.to||"").toLowerCase(),
  wallet_is_gas_payer:String(tx.from||"").toLowerCase()===WALLET,
  gas_used:gasUsed.toString(),effective_gas_price_wei:gasPrice.toString(),
  network_gas_cost_matic:Number(gasUsed*gasPrice)/1e18,
  log_count:total,ctf_log_count:ctf,topics:TOPICS,
  log_groups:[...grouped.values()].sort((a,b)=>b.n-a.n).slice(0,45),
  caveat:"Transaction gas is paid by tx.from, not necessarily RN1. ERC1155 and ERC20 Transfer require decoding, ownership and token matching; log presence alone does not imply RN1 cash movement."};
}
const ctfAbi=new Interface([
"event PositionsMerge(address indexed stakeholder,address collateralToken,bytes32 indexed parentCollectionId,bytes32 indexed conditionId,uint256[] partition,uint256 amount)",
"event PositionSplit(address indexed stakeholder,address collateralToken,bytes32 indexed parentCollectionId,bytes32 indexed conditionId,uint256[] partition,uint256 amount)",
"event PayoutRedemption(address indexed redeemer,address indexed collateralToken,bytes32 indexed parentCollectionId,bytes32 conditionId,uint256[] indexSets,uint256 payout)",
"event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
"event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)"
]);
async function auditMarketSettlement(market:string){
 if(!/^0x[0-9a-f]{64}$/.test(market))throw Error("Bad market id");
 const [audit]=await db.unsafe(`select market_key,title,cohort,timeline,
 round(merge_in,6)::float8 expected_merge_collateral,
 round(redeem_in,6)::float8 expected_redeem_collateral
 from pi.rn1_ledger_holdout_audit where market_key=$1 and evidence_status='gross_cash_balanced_dust'`,[market]);
 if(!audit)throw Error("Not a preselected balanced holdout");
 const txids=[...new Set(audit.timeline.filter((v:any)=>["MERGE","REDEEM"].includes(v.kind))
   .map((v:any)=>String(v.tx||"").toLowerCase()))];
 if(!txids.length||txids.length>3)throw Error("Unexpected count of settlement tx");
 const r:any[]=[];
 for(const txhash of txids){
  const [receipt,tx]=await Promise.all([rpc("eth_getTransactionReceipt",[txhash]),rpc("eth_getTransactionByHash",[txhash])]);
  if(String(receipt.transactionHash||"").toLowerCase()!==txhash||Number(BigInt(receipt.status||"0x0"))!==1)throw Error("Bad receipt");
  const gas=BigInt(receipt.gasUsed||"0x0")*BigInt(receipt.effectiveGasPrice||tx.gasPrice||"0x0");
  const matches:any[]=[],splitMatches:any[]=[],walletTransfers:any[]=[];
  for(const log of receipt.logs||[]){
   if(String(log.address||"").toLowerCase()!==CTF)continue;
   let ev:any=null;try{ev=ctfAbi.parseLog({topics:log.topics,data:log.data})}catch{continue}
   if(!ev)continue;
   if(ev.name==="TransferSingle"||ev.name==="TransferBatch"){
    const from=String(ev.args.from).toLowerCase(),to=String(ev.args.to).toLowerCase();
    if(from===WALLET||to===WALLET){
     const ids=ev.name==="TransferSingle"?[ev.args.id]:[...ev.args.ids];
     const values=ev.name==="TransferSingle"?[ev.args.value]:[...ev.args.values];
     walletTransfers.push({kind:ev.name,from,to,log_index:Number(BigInt(log.logIndex)),
      token_count:ids.length,
      values_parts:values.map((x:bigint)=>Number(x)/1e6),
      token_ids:ids.map((x:bigint)=>x.toString()).slice(0,12)});
    }
    continue;
   }
   if(ev.name==="PositionsMerge"||ev.name==="PositionSplit"){
    if(String(ev.args.conditionId).toLowerCase()!==market)continue;
    const item={kind:ev.name,stakeholder:String(ev.args.stakeholder).toLowerCase(),
     collateral_contract:String(ev.args.collateralToken).toLowerCase(),
     amount_parts:Number(ev.args.amount)/1e6,log_index:Number(BigInt(log.logIndex)),
     partition:ev.args.partition.map((x:bigint)=>x.toString())};
    if(ev.name==="PositionsMerge")matches.push(item);else splitMatches.push(item);
   }else if(ev.name==="PayoutRedemption"){
    if(String(ev.args.conditionId).toLowerCase()!==market)continue;
    matches.push({kind:"PayoutRedemption",redeemer:String(ev.args.redeemer).toLowerCase(),
     collateral_contract:String(ev.args.collateralToken).toLowerCase(),
     payout_collateral:Number(ev.args.payout)/1e6,log_index:Number(BigInt(log.logIndex)),
     index_sets:ev.args.indexSets.map((x:bigint)=>x.toString())});
   }
  }
  r.push({txhash,tx_from:String(tx.from||"").toLowerCase(),tx_to:String(tx.to||"").toLowerCase(),
   wallet_gas_payer:String(tx.from||"").toLowerCase()===WALLET,
   transaction_gas_matic:Number(gas)/1e18,tx_log_count:receipt.logs?.length||0,
   matched_contract_events:matches,matched_splits:splitMatches,wallet_erc1155_transfers:walletTransfers});
 }
 const chainEvents=r.flatMap(x=>x.matched_contract_events.map((ev:any)=>({...ev,txhash:x.txhash})));
 const sourceSettlements=audit.timeline.filter((v:any)=>v.kind==="MERGE"||v.kind==="REDEEM");
 const sourcePositiveRedemptions=sourceSettlements.filter((v:any)=>v.kind==="REDEEM"&&Number(v.cash_delta)>0);
 const redeemMatches:any[]=[];
 for(const src of sourcePositiveRedemptions){
  const target=Number(src.cash_delta);
  const matches=chainEvents.filter((e:any)=>e.kind==="PayoutRedemption"
     &&e.txhash===String(src.tx).toLowerCase()
     &&Math.abs(e.payout_collateral-target)<.000002);
  redeemMatches.push({txhash:String(src.tx).toLowerCase(),source_payout:target,
    matching_market_log_count:matches.length,
    matching_logs:matches.slice(0,5),
    independently_identified_recipient:matches.some((e:any)=>e.redeemer===WALLET)});
 }
 const mergeSource=sourceSettlements.filter((v:any)=>v.kind==="MERGE");
 const mergeMatches=mergeSource.map((v:any)=>{
  const exact=chainEvents.filter((e:any)=>e.kind==="PositionsMerge" &&
   e.txhash===String(v.tx).toLowerCase()&&Math.abs(e.amount_parts-Number(v.shares))<.000002);
  return {txhash:String(v.tx).toLowerCase(),source_parts:Number(v.shares),matching_logs:exact.length,
   stakeholders:exact.map((e:any)=>e.stakeholder)};
 });
 const unrelatedSameMarketRedemptions=chainEvents.filter((e:any)=>e.kind==="PayoutRedemption").length-
   redeemMatches.reduce((n:number,x:any)=>n+x.matching_market_log_count,0);
 return {market,title:audit.title,status:"onchain_event_by_event_amount_matching",
  tx_count:r.length,transactions:r.map((x:any)=>({txhash:x.txhash,tx_from:x.tx_from,
    tx_to:x.tx_to,wallet_gas_payer:x.wallet_gas_payer,
    transaction_gas_matic:x.transaction_gas_matic,log_count:x.tx_log_count,
    same_market_merge_events:x.matched_contract_events.filter((e:any)=>e.kind==="PositionsMerge").length,
    same_market_redeem_events:x.matched_contract_events.filter((e:any)=>e.kind==="PayoutRedemption").length,
    same_market_splits:x.matched_splits.length,
    wallet_erc1155_transfer_events:x.wallet_erc1155_transfers.length,
    wallet_erc1155_transfer_values:x.wallet_erc1155_transfers})),
  merge_matches:mergeMatches,positive_redeem_matches:redeemMatches,
  zero_payout_source_lines:sourceSettlements.filter((v:any)=>v.kind==="REDEEM"&&Number(v.cash_delta)===0).length,
  extra_same_market_redeem_logs:unrelatedSameMarketRedemptions,
  all_merge_events_matched:mergeMatches.every((x:any)=>x.matching_logs===1),
  all_positive_redemptions_matched:redeemMatches.every((x:any)=>x.matching_market_log_count===1),
  all_tx_gas_sponsored:r.every((x:any)=>!x.wallet_gas_payer),
  source_merge:audit.expected_merge_collateral,source_redeem:audit.expected_redeem_collateral,
  evidence_warning:"Batch receipts can contain payouts for OTHER wallets in the SAME market. Source payouts are matched separately by exact amount and transaction hash; this is not proof of ultimate payout beneficiary where a router batches transfers. Zero-payout redemptions cannot be identified from payout value alone. No transaction gas charged to RN1 without reimbursement evidence."};
}
Deno.serve(async(req:Request)=>{
 try{
  if(req.method!=="POST")return resp({error:"Method not allowed"},405);
  if(!await authorized(req))return resp({error:"Not authorized"},401);
  const body=await req.json();
  if(body?.action==="audit_settlement")return resp(await auditMarketSettlement(String(body.market_key||"").toLowerCase()));
  if(body?.action!=="receipt_probe")return resp({error:"Bad action"},400);
  return resp(await probe(String(body.market_key||"").toLowerCase(),String(body.kind||"")));
 }catch(e){return resp({error:String(e).slice(0,200)},500)}
});
