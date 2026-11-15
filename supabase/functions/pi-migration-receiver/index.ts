// Migration receiver: destination-only, private, authenticated, raw byte copying.
// Never expose this endpoint to an unauthenticated migration request.
import postgres from "npm:postgres@3.4.3";
const DB=Deno.env.get("SUPABASE_DB_URL")||"";
const URL=Deno.env.get("SUPABASE_URL")||"";
const SERVICE=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
if(!DB||!URL||!SERVICE)throw Error("Missing destination server secrets");
const sql=postgres(DB,{max:1,prepare:false,connect_timeout:10});
const BUCKET="pi-rn1-research-private";
const send=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"no-store"}});
async function digest(bytes:Uint8Array){
 const d=await crypto.subtle.digest("SHA-256",bytes);
 return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function authorised(req:Request){
 const token=req.headers.get("x-pi-migration-token")||"";
 if(!/^[0-9a-f]{64}$/.test(token))return false;
 const h=await digest(new TextEncoder().encode(token));
 const r=await sql.unsafe("select 1 from pi.migration_auth where singleton=true and token_sha256=$1",[h]);
 return r.length===1;
}
async function copyObject(req:Request){
 const name=req.headers.get("x-pi-object-name")||"";
 const expected=req.headers.get("x-pi-object-sha256")||"";
 if(name.length>250||!/^[a-zA-Z0-9_.\/-]+$/.test(name)||name.includes("..")||name.startsWith("/")||!/^[a-f0-9]{64}$/.test(expected))
  return send({error:"invalid_path_or_sha"},400);
 const size=Number(req.headers.get("content-length")||0);
 if(size>19000000)return send({error:"file_too_big"},413);
 const bytes=new Uint8Array(await req.arrayBuffer());
 if(bytes.length<1||bytes.length>19000000)return send({error:"invalid_bytes"},413);
 const actual=await digest(bytes);
 if(actual!==expected)return send({error:"sha256_mismatch"},400);
 const existing=await sql.unsafe("select sha256,byte_count from pi.migration_objects where bucket_id=$1 and object_name=$2",[BUCKET,name]);
 if(existing.length&&existing[0].sha256===actual&&Number(existing[0].byte_count)===bytes.length)
  return send({ok:true,already_copied:true,object:name,size:bytes.length});
 if(existing.length)return send({error:"existing_object_checksum_disagrees"},409);
 const upload=await fetch(URL+"/storage/v1/object/"+BUCKET+"/"+name.split("/").map(encodeURIComponent).join("/"),{
  method:"POST",headers:{Authorization:"Bearer "+SERVICE,apikey:SERVICE,"Content-Type":"application/octet-stream","x-upsert":"false"},
  body:bytes,signal:AbortSignal.timeout(30000)
 });
 if(!upload.ok)return send({error:"destination_upload_error",status:upload.status,details:(await upload.text()).slice(0,150)},502);
 await sql.unsafe("insert into pi.migration_objects(bucket_id,object_name,byte_count,sha256) values($1,$2,$3,$4) on conflict(bucket_id,object_name) do nothing",[BUCKET,name,bytes.length,actual]);
 return send({ok:true,object:name,size:bytes.length});
}
// SQL row batches are sent only from the authenticated source migration worker.
// Table name and PK are resolved *again* from destination PostgreSQL catalog.
async function copyRows(req:Request){
 const expected=req.headers.get("x-pi-row-sha256")||"";
 if(!/^[0-9a-f]{64}$/.test(expected))return send({error:"invalid_batch_sha"},400);
 const bytes=new Uint8Array(await req.arrayBuffer());
 if(bytes.length<3||bytes.length>4500000)return send({error:"invalid_batch_size"},413);
 if(await digest(bytes)!==expected)return send({error:"batch_checksum_mismatch"},400);
 const rawPayload=new TextDecoder().decode(bytes);
 const data=JSON.parse(rawPayload);
 const table=String(data?.table||"");
 const batchKey=String(data?.batch_key||"");
 const rows=data?.rows;
 if(!/^[a-z][a-z0-9_]{0,100}$/.test(table)||table.startsWith("migration_")||
  ["dashboard_access","scheduler_auth"].includes(table)||!Array.isArray(rows)||rows.length<1||rows.length>550||
  !/^[a-f0-9]{64}$/.test(batchKey))return send({error:"invalid_table_or_rows"},400);
 const tableRows=await sql.unsafe(`SELECT c.oid::regclass::text table_name
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='pi' AND c.relname=$1 AND c.relkind='r'`,[table]);
 if(tableRows.length!==1)return send({error:"unknown_destination_table"},400);
 const columns=await sql.unsafe(`SELECT a.attname name
 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='pi' AND c.relname=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[table]);
 const pks=await sql.unsafe(`SELECT a.attname name FROM pg_index i
 JOIN pg_class c ON c.oid=i.indrelid
 JOIN pg_namespace n ON n.oid=c.relnamespace
 JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ord) ON TRUE
 JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum
 WHERE n.nspname='pi' AND c.relname=$1 AND i.indisprimary ORDER BY k.ord`,[table]);
 if(!pks.length||!columns.length)return send({error:"missing_primary_key_or_columns"},400);
 const check=await sql.unsafe("select jsonb_typeof(($1::text::jsonb)->'rows') as kind, jsonb_array_length(($1::text::jsonb)->'rows') as n",[rawPayload]).catch(e=>[{error:String(e).slice(0,100)}]);
 if(check[0]?.kind!=="array")return send({error:"receiver_json_param_nonarray",server_kind:check[0]?.kind,server_error:check[0]?.error,
  js_array:Array.isArray(rows),length:rows.length},400);
 const quote=(x:string)=>'"'+x.replaceAll('"','""')+'"';
 const primary=pks.map(x=>x.name);
 const nonprimary=columns.map(x=>x.name).filter(x=>!primary.includes(x));
 // Source row JSON is a full typed PostgreSQL composite; upsert is idempotent.
 const command=`INSERT INTO pi.${quote(table)} OVERRIDING SYSTEM VALUE
 SELECT * FROM jsonb_populate_recordset(NULL::pi.${quote(table)},($1::text::jsonb)->'rows')
 ON CONFLICT (${primary.map(quote).join(",")}) DO ${nonprimary.length?
  "UPDATE SET "+nonprimary.map(c=>quote(c)+"=EXCLUDED."+quote(c)).join(","):
  "NOTHING"}`;
 let applied=0;
 await sql.begin(async tx=>{
  const existing=await tx.unsafe("select content_sha256,row_count from pi.migration_batches where source_table=$1 and batch_key=$2",[table,batchKey]);
  if(existing.length){
   if(existing[0].content_sha256!==expected||Number(existing[0].row_count)!==rows.length)throw Error("Conflicting previously applied batch");
   applied=-1;return;
  }
  await tx.unsafe(command,[rawPayload]);
  await tx.unsafe("insert into pi.migration_batches(source_table,batch_key,row_count,content_sha256) values($1,$2,$3,$4)",[table,batchKey,rows.length,expected]);
  applied=rows.length;
 });
 return send({ok:true,table,accepted:rows.length,already_copied:applied===-1});
}
// Read back the two causal RN1 replay state checkpoints from destination
// Storage (not just migration metadata), and verify exact stored byte digests.
async function verifyCriticalCheckpoints(){
 const rows=await sql.unsafe(`SELECT object_name,sha256,byte_count FROM pi.migration_objects
  WHERE bucket_id=$1 AND (object_name LIKE 'replay-v1/checkpoints/%'
     OR object_name LIKE 'independent-prices-v1/state/%') ORDER BY object_name`,[BUCKET]);
 if(rows.length!==2)return {ok:false,error:"unexpected_checkpoint_count",count:rows.length};
 const results=[];
 for(const r of rows){
  const url=URL+"/storage/v1/object/"+BUCKET+"/"+String(r.object_name).split("/").map(encodeURIComponent).join("/");
  const fetched=await fetch(url,{headers:{Authorization:"Bearer "+SERVICE,apikey:SERVICE},
   signal:AbortSignal.timeout(30000)});
  if(!fetched.ok)return {ok:false,error:"checkpoint_read_error",status:fetched.status};
  const bytes=new Uint8Array(await fetched.arrayBuffer());
  const verified=bytes.length===Number(r.byte_count)&&await digest(bytes)===r.sha256;
  results.push({object:r.object_name,bytes:bytes.length,verified});
 }
 return {ok:results.every(r=>r.verified),results};
}
Deno.serve(async req=>{
 if(req.method!=="POST")return send({error:"method_not_allowed"},405);
 if(!await authorised(req))return send({error:"forbidden"},403);
 const action=req.headers.get("x-pi-migration-action");
 if(!["copy-object","copy-rows","verify-critical"].includes(action||""))return send({error:"action_not_supported"},400);
 try{return action==="copy-object"?await copyObject(req):action==="copy-rows"?await copyRows(req):send(await verifyCriticalCheckpoints())}
 catch(e){return send({error:"transfer_failed",message:String(e).slice(0,180)},500)}
});