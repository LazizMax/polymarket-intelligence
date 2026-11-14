// Authenticated Polymarket Intelligence web API, read-only analytics.
import postgres from "npm:postgres@3.4.3";
import { renderPage } from "./page.ts";
const url = Deno.env.get("SUPABASE_URL") || "";
const pub = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "";
const dbUrl = Deno.env.get("SUPABASE_DB_URL") || "";
if (!url || !pub || !dbUrl) throw Error("Supabase runtime config unavailable");
const db = postgres(dbUrl,{ max:2, prepare:false, connect_timeout:10, idle_timeout:5 });
const walletPattern = /^0x[0-9a-f]{40}$/;
const jsonHeaders = { "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store", "X-Content-Type-Options":"nosniff" };
const send = (x: unknown, status=200) => Response.json(x,{status,headers:jsonHeaders});
function number(x: unknown, defaultVal:number, min:number, max:number):number {
 const n=Number(x); return Number.isFinite(n)?Math.max(min,Math.min(max,n)):defaultVal;
}
function s(x:unknown, limit=100):string { return typeof x==="string"?x.trim().slice(0,limit):""; }
async function allowed(req:Request):Promise<boolean>{
 const header=req.headers.get("authorization")||"";
 const token=header.startsWith("Bearer ")?header.slice(7):"";
 if(token.length<20||token.length>5000)return false;
 const response=await fetch(url+"/auth/v1/user",{
  headers:{apikey:pub,authorization:"Bearer "+token},
  signal:AbortSignal.timeout(8000),cache:"no-store"
 });
 if(!response.ok)return false;
 const user=await response.json();
 if(typeof user?.id!=="string" || !/^[0-9a-f-]{36}$/.test(user.id))return false;
 const rows=await db.unsafe("select enabled from pi.dashboard_access where user_id=$1::uuid and enabled=true",[user.id]);
 return rows.length===1;
}
async function overview(){
 const r=await db.unsafe(`
  select (select count(*)::integer from pi.wallets) wallets,
   (select count(*)::integer from pi.wallet_pnl_daily) observations,
   (select count(*)::integer from pi.wallet_metrics_daily where observation_days>=90) long_histories,
   (select count(*)::integer from pi.wallet_metrics_daily where largest_positive_day_share_pct>50) concentrated,
   (select count(*)::integer from pi.wallet_equity_daily where complete_market_valuation and external_flows_reconciled) equity_verified,
   (select max(collected_at)::text from pi.wallet_pnl_daily) collected_at,
   (select max(day)::text from pi.wallet_pnl_daily) last_source_day,
   (select pg_size_pretty(coalesce(sum(pg_total_relation_size(c.oid)),0)::bigint)
     from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='pi' and c.relkind in ('r','p')) storage
 `);return r[0]??{};
}
const sorts:Record<string,string>={
 regularity:"m.pnl_linearity_r2 desc nulls last,m.observation_days desc",
 pnl:"m.pnl_observed_change_usdc desc nulls last",
 recovery:"m.pnl_recovery_factor desc nulls last",
 positive:"m.positive_active_change_pct desc nulls last",
 concentration:"m.largest_positive_day_share_pct asc nulls last",
 drawdown:"m.max_observed_pnl_drawdown_usdc asc nulls last",
};
async function leaderboard(body:any){
 const page=Math.round(number(body.page,1,1,100000)),per=Math.round(number(body.per,20,5,40));
 const days=Math.round(number(body.days,90,2,2000)),maxDay=number(body.max_day,100,0,100);
 const positive=body.positive!==false,query=s(body.q,80).toLowerCase();
 const sort=sorts[s(body.sort,20)]||sorts.regularity;
 const sql=`select w.wallet,coalesce(nullif(w.display_name,''),w.wallet) name,
 m.day::text as last_day,m.observation_days days,
 m.pnl_observed_change_usdc::double precision pnl,
 m.max_observed_pnl_drawdown_usdc::double precision dd,
 m.pnl_recovery_factor::double precision recovery,
 m.pnl_linearity_r2::double precision r2,
 m.positive_active_change_pct::double precision positive_active,
 m.largest_positive_day_share_pct::double precision concentration,
 m.missing_pnl_days missing_days,m.quality_status quality,
 count(*) over()::integer total
 from pi.wallets w join lateral(
  select * from pi.wallet_metrics_daily x where x.wallet=w.wallet order by day desc limit 1
 ) m on true
 where m.observation_days >= $1
 and (not $2::boolean or m.pnl_observed_change_usdc>0)
 and (m.largest_positive_day_share_pct<=$3 or m.largest_positive_day_share_pct is null)
 and ($4='' or lower(coalesce(w.display_name,'')) like '%'||$4||'%' or w.wallet like '%'||$4||'%')
 order by `+sort+`,w.wallet limit $5 offset $6`;
 const rows=await db.unsafe(sql,[days,positive,maxDay,query,per,(page-1)*per]);
 return {rows,total:rows[0]?.total??0,page,per,metric_note:"Observed historical PnL only; no validated capital ROI or copy-trading edge."};
}
async function wallet(body:any){
 const address=s(body.wallet,50).toLowerCase();
 if(!walletPattern.test(address))return send({error:"Invalid wallet"},400);
 const period=["90d","365d","all"].includes(body.period)?body.period:"365d";
 const days=period==="90d"?90:period==="365d"?365:3650;
 const info=await db.unsafe(`
 select w.wallet,coalesce(nullif(w.display_name,''),w.wallet) name,w.tags,
 m.day::text last_day,m.observation_days days,
 m.pnl_observed_change_usdc::double precision pnl,
 m.max_observed_pnl_drawdown_usdc::double precision dd,
 m.pnl_recovery_factor::double precision recovery,
 m.pnl_linearity_r2::double precision r2,
 m.positive_active_change_pct::double precision positive_active,
 m.largest_positive_day_share_pct::double precision concentration,
 m.missing_pnl_days missing_days,m.pnl_observed_from::text first_day,
 m.pnl_observed_through::text through_day,m.quality_status quality
 from pi.wallets w left join lateral (
 select * from pi.wallet_metrics_daily x where x.wallet=w.wallet order by day desc limit 1
 ) m on true where w.wallet=$1
 `,[address]);
 if(!info.length)return send({error:"Wallet unknown"},404);
 const series=await db.unsafe(`
 with selected as (
  select day,economic_pnl_usdc pnl,realized_pnl_usdc realized
  from pi.wallet_pnl_daily
  where wallet=$1 and source='polymarket_v2_user_pnl'
   and day >= current_date - $2::integer
  order by day desc limit 1900
 ), lines as (
  select day,pnl,realized,max(pnl) over(order by day rows unbounded preceding) peak
  from selected
 )
 select day::text day,pnl::double precision pnl,realized::double precision realized,
  (peak-pnl)::double precision dd
 from lines order by day
 `,[address,days]);
 return {info:info[0],series,warning:"Drawdown in USDC is the peak-to-trough of observed PnL within the selected window, not portfolio drawdown."};
}
async function health(){
 const r=await db.unsafe(`
 select
 (select count(*)::integer from pi.wallets) wallets,
 (select count(*)::integer from pi.wallet_pnl_daily) pnl_rows,
 (select count(*)::integer from pi.trades) trades,
 (select count(*)::integer from pi.position_snapshots) positions,
 (select count(*)::integer from pi.wallet_activity) activities,
 (select count(*)::integer from pi.wallet_equity_daily) equity,
 (select count(*)::integer from pi.wallet_metrics_daily where missing_pnl_days>0) gapped,
 (select max(collected_at)::text from pi.wallet_pnl_daily) last_collection
 `);
 const jobs=await db.unsafe(`
 select id::text,wallet,stream,status,pages_fetched,rows_fetched,
 started_at::text,finished_at::text,left(coalesce(error_message,''),100) error
 from pi.ingestion_jobs order by id desc limit 15
 `);
 return {stats:r[0]??{},jobs};
}
Deno.serve(async(req:Request)=>{
 if(req.method==="GET"){
  return new Response(renderPage(url,pub),{headers:{
   "Content-Type":"text/html; charset=utf-8",
   "Cache-Control":"no-store",
   "X-Content-Type-Options":"nosniff",
   "X-Frame-Options":"DENY",
   "Content-Security-Policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' "+url+"; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  }});
 }
 if(req.method!=="POST")return send({error:"Method not allowed"},405);
 if(Number(req.headers.get("content-length")||0)>6000)return send({error:"Payload too large"},413);
 try{
  if(!await allowed(req))return send({error:"Session non autorisée"},401);
  const body=await req.json();
  if(body?.action==="overview")return send(await overview());
  if(body?.action==="leaderboard")return send(await leaderboard(body));
  if(body?.action==="wallet")return send(await wallet(body));
  if(body?.action==="health")return send(await health());
  return send({error:"Action inconnue"},400);
 }catch(e){
  console.error("pi-dashboard",e instanceof Error?e.message.slice(0,160):"unknown");
  return send({error:"Erreur lors de la lecture des données"},500);
 }
});
