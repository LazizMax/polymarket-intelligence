// Private incremental SQL exporter. Source tables are never modified.
// Destination receives typed JSON rows via an authenticated, idempotent receiver.
import postgres from "npm:postgres@3.4.3";
const DB=Deno.env.get("SUPABASE_DB_URL")||"";
if(!DB)throw Error("Source connection missing");
const db=postgres(DB,{max:1,prepare:false,connect_timeout:10});
const DEST="https://qamdvfakwclkuswrdckp.supabase.co/functions/v1/pi-migration-receiver";
const respond=(x:any,status=200)=>Response.json(x,{status,headers:{"Cache-Control":"no-store"}});
async function sha(bytes:Uint8Array){const out=await crypto.subtle.digest("SHA-256",bytes);return [...new Uint8Array(out)].map(x=>x.toString(16).padStart(2,"0")).join("")}
async function authorised(req:Request){
 const token=req.headers.get("x-pi-scheduler-token")||"";
 if(!/^[0-9a-f]{64}$/.test(token))return false;
 return (await db.unsafe("select 1 from pi.scheduler_auth where single_row_id=1 and token_sha256=$1",[await sha(new TextEncoder().encode(token))])).length===1;
}
function quote(value:string){if(!/^[a-z][a-z0-9_]{0,100}$/.test(value))throw Error("Unsafe identifier");return '"'+value+'"'}
function pgArray(value:any):string[]{
 if(Array.isArray(value))return value.map(String);
 const raw=String(value||"");return raw.startsWith("{")&&raw.endsWith("}")?raw.slice(1,-1).split(",").filter(Boolean):[];
}
async function migrateBatch(){
 const jobs=await db.unsafe(`select table_name,pk_fields,cursor_pk,rows_copied,order_no
 from pi.migration_table_export_state
 where status in ('ready','running') and (lease_until is null or lease_until<now())
 order by order_no limit 1`);
 if(!jobs.length)return {status:"initial_pass_complete"};
 const job=jobs[0],table=String(job.table_name);
 if(table.startsWith("migration_")||["dashboard_access","scheduler_auth"].includes(table))throw Error("Protected table");
 const pk=pgArray(job.pk_fields),cursor=job.cursor_pk;
 if(!pk.length||pk.some(x=>!/^[a-z][a-z0-9_]{0,100}$/.test(x)))throw Error("Missing safe primary key");
 const claimed=await db.unsafe(`update pi.migration_table_export_state
 set status='running',lease_until=now()+interval '115 seconds',updated_at=now()
 where table_name=$1 and cursor_pk is not distinct from $2::text::jsonb
 and (lease_until is null or lease_until<now())
 returning table_name`,[table,cursor===null?null:JSON.stringify(cursor)]);
 if(!claimed.length)return {status:"leased"};
 try{
  const secret=await db.unsafe("select decrypted_secret from vault.decrypted_secrets where name='pi_migration_bridge_20261115'");
  if(secret.length!==1||!secret[0].decrypted_secret)throw Error("Source migration secret absent");
  const types=await db.unsafe(`select a.attname name,format_type(a.atttypid,a.atttypmod) type from pg_attribute a
  join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='pi' and c.relname=$1 and a.attname=any($2::text[])`,[table,pk]);
  const by=new Map(types.map(t=>[t.name,t.type]));
  if(by.size!==pk.length)throw Error("Incomplete PK definition");
  const where=cursor===null?"":`where (${pk.map(quote).join(",")}) > (${pk.map((key,i)=>"$"+(i+1)+"::"+by.get(key)).join(",")})`;
  if(cursor!==null&&(!Array.isArray(cursor)||cursor.length!==pk.length))throw Error("Malformed cursor");
  const query=`select to_jsonb(t) as row_data from (
   select * from pi.${quote(table)} ${where}
   order by ${pk.map(quote).join(",")} limit 500) t`;
  const entries=await db.unsafe(query,cursor||[]);
  if(!entries.length){
   await db.unsafe("update pi.migration_table_export_state set status='done',lease_until=null,updated_at=now(),last_success_at=now() where table_name=$1",[table]);
   return {status:"table_complete",table};
  }
  const rows=entries.map(x=>x.row_data),last=rows.at(-1);
  const nextCursor=pk.map(x=>last[x]);
  // A final delta sweep may revisit the same PK range after source rows changed.
  // Include row contents in batch identity so changed data gets a new verified
  // idempotent upsert instead of conflicting with the original immutable batch.
  const keySeed=new TextEncoder().encode(JSON.stringify({table,previous:cursor,next:nextCursor,rows}));
  const batchKey=await sha(keySeed);
  const body=new TextEncoder().encode(JSON.stringify({table,batch_key:batchKey,rows}));
  if(body.length>4400000)throw Error("Migration row batch too large");
  const digest=await sha(body);
  const pushed=await fetch(DEST,{method:"POST",headers:{
   "x-pi-migration-token":String(secret[0].decrypted_secret),
   "x-pi-migration-action":"copy-rows",
   "x-pi-row-sha256":digest,"Content-Type":"application/json"
  },body,signal:AbortSignal.timeout(45000)});
  const output=await pushed.json().catch(()=>({error:"unreadable_response"}));
  if(!pushed.ok||!output.ok)throw Error("Destination row batch rejected "+JSON.stringify(output).slice(0,230));
  const advanced=await db.unsafe(`update pi.migration_table_export_state
   set cursor_pk=$2::text::jsonb,rows_copied=rows_copied+$3,batches_done=batches_done+1,
   lease_until=null,last_success_at=now(),updated_at=now(),last_error=null,error_attempts=0
   where table_name=$1 and cursor_pk is not distinct from $4::text::jsonb returning rows_copied`,
   [table,JSON.stringify(nextCursor),rows.length,cursor===null?null:JSON.stringify(cursor)]);
  if(advanced.length!==1)throw Error("Source cursor changed unexpectedly");
  return {status:"running",table,rows:rows.length,total:advanced[0].rows_copied};
 }catch(e){
  const msg=String(e).slice(0,260);
  await db.unsafe("update pi.migration_table_export_state set status=case when error_attempts+1>=5 then 'error' else 'running' end,error_attempts=error_attempts+1,last_error=$2,lease_until=now()+interval '30 seconds',updated_at=now() where table_name=$1",[table,msg]);
  return {status:"error",table,message:msg};
 }
}
Deno.serve(async req=>{
 if(req.method!=="POST")return respond({error:"method_not_allowed"},405);
 if(!await authorised(req))return respond({error:"forbidden"},403);
 let data:any={};try{data=await req.json()}catch(_){}
 if(data.action!=="transfer_sql")return respond({error:"invalid_action"},400);
 const count=Math.min(12,Math.max(1,Number.isInteger(data.count)?data.count:5));
 const results:any[]=[];
 for(let i=0;i<count;i++){
  const current=await migrateBatch();results.push(current);
  if(!["running","table_complete"].includes(current.status))break;
 }
 return respond({status:results.at(-1)?.status||"idle",batches:results.filter(x=>x.rows).length,results});
});