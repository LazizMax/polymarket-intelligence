/** Stop only after a recent scan reaches the overlap boundary and its
 * API page is fully timestamped in descending order. Full audits never
 * short-circuit: they must exhaust the server cursor. */
export function closesPageComplete(
  mode:string, hasMore:boolean, timestamps:(number|null)[],cutoffMs:number|null
):boolean {
 if(!hasMore)return true;
 if(mode!=="recent"||cutoffMs===null||!Number.isFinite(cutoffMs))return false;
 if(timestamps.length===0||timestamps.some(ts=>ts===null||!Number.isFinite(ts)))return false;
 for(let i=1;i<timestamps.length;i++){
  if(timestamps[i-1]! < timestamps[i]!)return false;
 }
 return timestamps[timestamps.length-1]! < cutoffMs;
}
