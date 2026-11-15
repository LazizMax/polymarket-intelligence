/** Official Polymarket Data API v2 /activity, preserving original event types.
 * No row is treated as net PnL or maker/taker attribution. Raw pages retain provenance.
 */
export const RN1="0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
const WALLET=/^0x[a-f0-9]{40}$/, HASH=/^0x[a-f0-9]{64}$/;
const decimal=(v:unknown):number|null=>{
 if(v===null||v===undefined||typeof v==="boolean"||v==="")return null;
 const n=Number(v);return Number.isFinite(n)?n:null;
};
export function normalizeActivity(raw:any,wallet=RN1):Record<string,unknown>|null{
 const proxy=String(raw?.proxy_wallet??"").toLowerCase();
 const kind=String(raw?.type??"").toUpperCase().trim();
 const ts=decimal(raw?.timestamp);
 if(!WALLET.test(wallet)||proxy!==wallet||!kind||!/^[A-Z_]{2,40}$/.test(kind)
  ||ts===null||!Number.isSafeInteger(ts)||ts<946684800||ts>=4102444800)return null;
 const tx=String(raw?.transaction_hash??"").toLowerCase();
 const cond=String(raw?.condition_id??"").toLowerCase();
 const shares=decimal(raw?.size),unit=decimal(raw?.price),usdc=decimal(raw?.usdc_size);
 const outcome=decimal(raw?.outcome_index);
 return {wallet,occurred_at:new Date(ts*1000).toISOString(),kind,
  // No costs or profit can be derived from an isolated activity row.
  amount_usdc:null,amount_classification:"unknown",
  reported_usdc_size:usdc!==null&&usdc>=0?usdc:null,
  shares:shares!==null&&shares>=0?shares:null,
  unit_price:unit!==null&&unit>=0&&unit<=1?unit:null,
  side:/^(BUY|SELL)$/.test(String(raw?.side??"").toUpperCase())?String(raw.side).toUpperCase():null,
  market_key:HASH.test(cond)?cond:null,
  token_id:/^\d{20,90}$/.test(String(raw?.token_id??""))?String(raw.token_id):null,
  tx_hash:HASH.test(tx)?tx:null,
  outcome_index:outcome!==null&&Number.isSafeInteger(outcome)&&outcome>=0&&outcome<100?outcome:null,
  event_slug:String(raw?.event_slug??"").slice(0,230),
  market_title:String(raw?.title??"").slice(0,350)};
}
export function envelopeActivity(payload:unknown){
 const v=payload as any;
 if(!v||!Array.isArray(v.data)||!v.pagination||typeof v.pagination.has_more!=="boolean"
  ||v.data.length>500||v.data.length===0&&v.pagination.has_more)return null;
 const cursor=v.pagination.next_cursor;
 if(cursor!==null&&cursor!==undefined&&(typeof cursor!=="string"||cursor.length>2048))return null;
 if(v.pagination.has_more&&(!cursor||typeof cursor!=="string"))return null;
 return {data:v.data as any[],hasMore:v.pagination.has_more,nextCursor:typeof cursor==="string"&&cursor?cursor:null};
}
export async function sha256Activity(raw:string){
 const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(raw));
 return [...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
