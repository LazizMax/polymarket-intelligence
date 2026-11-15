/** Compare complete wallet fills with the official taker-only subset for an identical UTC window.
 * Role is inferred from API overlap, not an explicit role flag or on-chain log index.
 * Duplicate fills are matched as a MULTISET; transaction hashes are not unique fill IDs.
 */
export function rn1TradeSignature(r:any):string{
 return JSON.stringify([
  String(r?.transaction_hash??"").toLowerCase(),
  String(r?.token_id??""),
  String(r?.side??"").toUpperCase(),
  Number(r?.price),Number(r?.size),
  Number(r?.timestamp),
  String(r?.condition_id??"").toLowerCase()
 ]);
}
export function matchMakerTaker(full:any[],taker:any[]){
 const available=new Map<string,number>();
 for(const f of full){const k=rn1TradeSignature(f);available.set(k,(available.get(k)||0)+1);}
 let matched=0,unmatchedTaker=0;
 for(const f of taker){
  const k=rn1TradeSignature(f),n=available.get(k)||0;
  if(n>0){matched++;available.set(k,n-1)}
  else unmatchedTaker++;
 }
 const maker=full.length-matched;
 if(maker<0||matched>full.length)throw Error("Invalid maker/taker cardinality");
 return {maker,taker:matched,unmatchedTaker,all:full.length};
}
