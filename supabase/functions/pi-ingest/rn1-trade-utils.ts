/** Normalize observed rows of Polymarket Data API v2 /trades.
 * A tx_hash is NOT assumed unique; caller must preserve source page + row index.
 * Wallet maker/taker role, per-fill fee and net profit are NOT exposed by this endpoint.
 */
export const RN1="0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
const WALLET=/^0x[a-f0-9]{40}$/;
const HASH=/^0x[a-f0-9]{64}$/;
const TOKEN=/^[0-9]{20,90}$/;
function finite(v:unknown):number|null{
 if(typeof v==="boolean"||v===null||v===undefined||v==="")return null;
 const n=Number(v);return Number.isFinite(n)?n:null;
}
export function normalizeV2Trade(raw:any,wallet=RN1):null|Record<string,unknown>{
 const w=String(raw?.proxy_wallet??"").toLowerCase();
 const side=String(raw?.side??"").toUpperCase();
 const id=String(raw?.token_id??"");
 const condition=String(raw?.condition_id??"").toLowerCase();
 const tx=String(raw?.transaction_hash??"").toLowerCase();
 const shares=finite(raw?.size),price=finite(raw?.price),ts=finite(raw?.timestamp);
 if(!WALLET.test(wallet)||w!==wallet||!HASH.test(tx)||!HASH.test(condition)||!TOKEN.test(id)
   ||!(side==="BUY"||side==="SELL")||shares===null||shares<=0||price===null||price<0||price>1
   ||ts===null||!Number.isInteger(ts)||ts<946684800||ts>=4102444800)return null;
 const index=finite(raw?.outcome_index);
 return {wallet,side,token_id:id,market_key:condition,tx_hash:tx,
  shares,price,reported_at:new Date(ts*1000).toISOString(),
  observed_notional_usdc:shares*price,
  outcome_index:index!==null&&Number.isInteger(index)&&index>=0&&index<=99?index:null,
  outcome_label:String(raw?.outcome??"").slice(0,90),
  market_slug:String(raw?.slug??"").slice(0,230),
  event_slug:String(raw?.event_slug??"").slice(0,230),
  market_title:String(raw?.title??"").slice(0,350)};
}
export function pageEnvelope(payload:unknown){
 const p=payload as any;
 if(!p||!Array.isArray(p.data)||!p.pagination||typeof p.pagination!=="object"||
   typeof p.pagination.has_more!=="boolean"||
   p.data.length>500||p.data.length===0&&p.pagination.has_more===true)return null;
 const next=p.pagination.next_cursor;
 if(next!==null&&next!==undefined&&(typeof next!=="string"||next.length>2048))return null;
 if(p.pagination.has_more&&(!next||typeof next!=="string"))return null;
 return {data:p.data as any[],hasMore:p.pagination.has_more,nextCursor:typeof next==="string"&&next?next:null};
}
export async function sha256(text:string){
 const bytes=new TextEncoder().encode(text);
 const digest=await crypto.subtle.digest("SHA-256",bytes);
 return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
