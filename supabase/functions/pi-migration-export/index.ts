// Read-only migration source. Existing RN1 and wallet collectors remain active.
// Transfers compressed private archive objects; no deletion, no old-project cutover.
import postgres from "npm:postgres@3.4.3";
const DB=Deno.env.get("SUPABASE_DB_URL")||"";
const URL=Deno.env.get("SUPABASE_URL")||"";
const SERVICE=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
if(!DB||!URL||!SERVICE)throw Error("Missing source server secrets");
const sql=postgres(DB,{max:1,prepare:false,connect_timeout:10});
const BUCKET="pi-rn1-research-private";
const DEST="https://qamdvfakwclkuswrdckp.supabase.co/functions/v1/pi-migration-receiver";
const JOB="pi_storage_v1";
const send=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"no-store"}});
async function hash(text:string){
 const buf=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));
 return [...new Uint8Array(buf)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function authorised(req:Request){
 const token=req.headers.get("x-pi-scheduler-token")||"";
 if(!/^[0-9a-f]{64}$/.test(token))return false;
 const h=await hash(token);
 const r=await sql.unsafe("select 1 from pi.scheduler_auth where single_row_id=1 and token_sha256=$1",[h]);
 return r.length===1;
}
async function migrate(maxItems:number){
 const jobs=await sql.unsafe(`UPDATE pi.migration_export_state
 SET status='running',lease_until=now()+interval '115 seconds',updated_at=now()
 WHERE job_key=$1 AND status IN ('ready','running') AND
 (lease_until IS NULL OR lease_until<now())
 RETURNING object_cursor,objects_copied,bytes_copied`,[JOB]);
 if(!jobs.length)return {status:"idle_or_leased"};
 const cursor=String(jobs[0].object_cursor);
 try{
  const secrets=await sql.unsafe("select decrypted_secret from vault.decrypted_secrets where name='pi_migration_bridge_20261115'");
  if(secrets.length!==1||!secrets[0].decrypted_secret)throw Error("Migration secret unavailable in source Vault");
  const token=String(secrets[0].decrypted_secret);
  const objs=await sql.unsafe(`SELECT name,(metadata->>'size')::bigint AS bytes
  FROM storage.objects WHERE bucket_id=$1 AND name>$2
  ORDER BY name ASC LIMIT $3`,[BUCKET,cursor,maxItems]);
  if(!objs.length){
   await sql.unsafe("update pi.migration_export_state set status='done',lease_until=null,last_success_at=now(),updated_at=now() where job_key=$1",[JOB]);
   return {status:"initial_pass_complete",copied:0};
  }
  let copied=0,bytes=0,last=cursor;
  for(const o of objs){
   const name=String(o.name);
   if(!/^[a-zA-Z0-9_.\/-]+$/.test(name)||name.includes("..")||name.startsWith("/"))throw Error("Unsafe source object path");
   const got=await fetch(URL+"/storage/v1/object/"+BUCKET+"/"+name.split("/").map(encodeURIComponent).join("/"),{
    headers:{Authorization:"Bearer "+SERVICE,apikey:SERVICE},signal:AbortSignal.timeout(30000)});
   if(!got.ok)throw Error("Source object read HTTP "+got.status);
   const data=new Uint8Array(await got.arrayBuffer());
   if(data.length<1||data.length>19000000)throw Error("Unsafe source object size");
   const digest=await crypto.subtle.digest("SHA-256",data);
   const checksum=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
   const pushed=await fetch(DEST,{method:"POST",headers:{
    "x-pi-migration-token":token,"x-pi-migration-action":"copy-object",
    "x-pi-object-name":name,"x-pi-object-sha256":checksum,
    "Content-Type":"application/octet-stream"
   },body:data,signal:AbortSignal.timeout(45000)});
   const result=await pushed.json().catch(()=>({error:"unparseable_destination"}));
   if(!pushed.ok||!result.ok)throw Error("Destination rejected "+name+" "+JSON.stringify(result).slice(0,180));
   // Commit each completed object. A repeated item is verified-idempotent at destination.
   const updated=await sql.unsafe(`update pi.migration_export_state
    set object_cursor=$2,objects_copied=objects_copied+1,
    bytes_copied=bytes_copied+$3,last_success_at=now(),updated_at=now(),
    lease_until=now()+interval '115 seconds',last_error=null where job_key=$1
    and object_cursor=$4 returning object_cursor`,[JOB,name,data.length,last]);
   if(updated.length!==1)throw Error("Export cursor changed unexpectedly");
   last=name;copied++;bytes+=data.length;
  }
  await sql.unsafe("update pi.migration_export_state set lease_until=null where job_key=$1",[JOB]);
  return {status:"running",copied,bytes,last:copied?last:""};
 }catch(e){
  const error=String(e).slice(0,230);
  await sql.unsafe("update pi.migration_export_state set status='error',last_error=$2,lease_until=null,updated_at=now() where job_key=$1",[JOB,error]);
  return {status:"error",error};
 }
}
// Priority transfer of only the two verified replay checkpoints; does not
// advance or reset the ordinary lexicographic archive migration cursor.
async function copyReplayCheckpoints(){
 const jobs=await sql.unsafe(`select snapshot_key checkpoint from pi.rn1_replay_jobs
 union all select checkpoint_key checkpoint from pi.rn1_independent_price_jobs`);
 const vault=await sql.unsafe("select decrypted_secret from vault.decrypted_secrets where name='pi_migration_bridge_20261115'");
 if(vault.length!==1||!vault[0].decrypted_secret)throw Error("Source Vault migration token unavailable");
 const token=String(vault[0].decrypted_secret);
 const results:any[]=[];
 for(const row of jobs){
  const name=String(row.checkpoint||"");
  if(!/^(replay-v1\/checkpoints|independent-prices-v1\/state)\/[a-zA-Z0-9_.-]+$/.test(name))
   throw Error("Unsafe or absent replay checkpoint");
  const r=await fetch(URL+"/storage/v1/object/"+BUCKET+"/"+name.split("/").map(encodeURIComponent).join("/"),
   {headers:{Authorization:"Bearer "+SERVICE,apikey:SERVICE},signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw Error("Private checkpoint source read failed "+r.status);
  const data=new Uint8Array(await r.arrayBuffer());
  const h=new Uint8Array(await crypto.subtle.digest("SHA-256",data));
  const hash=[...h].map(x=>x.toString(16).padStart(2,"0")).join("");
  const pushed=await fetch(DEST,{method:"POST",headers:{
   "x-pi-migration-token":token,"x-pi-migration-action":"copy-object",
   "x-pi-object-name":name,"x-pi-object-sha256":hash,"Content-Type":"application/octet-stream"
  },body:data,signal:AbortSignal.timeout(45000)});
  const response=await pushed.json().catch(()=>({error:"unparseable_response"}));
  if(!pushed.ok||!response.ok)throw Error("Checkpoint destination rejected "+name+" "+JSON.stringify(response).slice(0,180));
  results.push({checkpoint:name,bytes:data.length,sha256:hash});
 }
 return {status:"copied_verified",checkpoints:results};
}
Deno.serve(async req=>{
 if(req.method!=="POST")return send({error:"method_not_allowed"},405);
 if(!await authorised(req))return send({error:"forbidden"},403);
 let data:any={};try{data=await req.json()}catch(_){}
 if(data.action==="copy_replay_checkpoints"){
  try{return send(await copyReplayCheckpoints())}catch(e){return send({error:String(e).slice(0,230)},500)}
 }
 if(data.action!=="transfer_storage")return send({error:"bad_action"},400);
 return send(await migrate(Math.min(25,Math.max(1,Number.isInteger(data.count)?data.count:12))));
});