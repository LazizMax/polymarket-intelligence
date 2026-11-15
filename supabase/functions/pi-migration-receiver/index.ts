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
Deno.serve(async req=>{
 if(req.method!=="POST")return send({error:"method_not_allowed"},405);
 if(!await authorised(req))return send({error:"forbidden"},403);
 if(req.headers.get("x-pi-migration-action")!=="copy-object")return send({error:"action_not_supported"},400);
 try{return await copyObject(req)}catch(e){return send({error:"transfer_failed",message:String(e).slice(0,180)},500)}
});