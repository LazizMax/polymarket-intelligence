// Authenticated Polymarket Intelligence web API, read-only analytics.
import postgres from "npm:postgres@3.4.3";
const url = Deno.env.get("SUPABASE_URL") || "";
const pub = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "";
const dbUrl = Deno.env.get("SUPABASE_DB_URL") || "";
if (!url || !pub || !dbUrl) throw Error("Supabase runtime config unavailable");
const db = postgres(dbUrl,{ max:2, prepare:false, connect_timeout:10, idle_timeout:5 });
const walletPattern = /^0x[0-9a-f]{40}$/;
const SITE="https://lazizmax.github.io/polymarket-intelligence/";
const SITE_ORIGIN="https://lazizmax.github.io";
const jsonHeaders = {
  "Content-Type":"application/json; charset=utf-8",
  "Cache-Control":"no-store",
  "X-Content-Type-Options":"nosniff",
  "Access-Control-Allow-Origin":SITE_ORIGIN,
  "Access-Control-Allow-Methods":"GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":"authorization, content-type",
  "Vary":"Origin"
};
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
 and (not $2::boolean or (m.pnl_observed_change_usdc>0 and m.pnl_slope_usdc_per_day>0))
 and ($3>=100 or (m.largest_positive_day_share_pct is not null and m.largest_positive_day_share_pct<=$3))
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
 select day::text AS day, pnl::double precision AS pnl, realized::double precision AS realized,
  (peak-pnl)::double precision AS dd
 from lines order by day
 `,[address,days]);
 return {info:info[0],series,warning:"Drawdown in USDC is the peak-to-trough of observed PnL within the selected window, not portfolio drawdown."};
}
// Each row is an outcome position, NOT an individual fill.
async function positionRoi(body:any){
 const address=s(body.wallet,50).toLowerCase();
 if(!walletPattern.test(address))return send({error:"Wallet invalide"},400);
 const page=Math.round(number(body.page,1,1,100000)),per=30;
 const stateRows=await db.unsafe(
  "select generation,exhausted,sync_mode,request_priority,pages_fetched,rows_seen,updated_at::text,last_complete_at::text,last_recent_at::text,last_full_audit_at::text,last_error,consecutive_failures from pi.roi_import_state where wallet=$1",[address]);
 const state=stateRows[0]??null;
 if(!state)return {state:null,summary:null,rows:[],page,per};
 const summaryRows=await db.unsafe(`
  select count(*)::integer AS total,
   count(*) filter(where valid_cost)::integer AS valid,
   count(*) filter(where not valid_cost)::integer AS invalid,
   sum(realized_pnl_usdc) filter(where valid_cost)::double precision AS realized_pnl,
   sum(estimated_entry_cost_usdc) filter(where valid_cost)::double precision AS capital_estimated,
   (100*sum(realized_pnl_usdc) filter(where valid_cost)/
       nullif(sum(estimated_entry_cost_usdc) filter(where valid_cost),0))::double precision AS roi_total_weighted,
   avg(estimated_roi_pct) filter(where valid_cost)::double precision AS roi_mean,
   percentile_cont(0.5) within group(order by estimated_roi_pct)
       filter(where valid_cost)::double precision AS roi_median,
   count(*) filter(where valid_cost and estimated_roi_pct>0)::integer winners,
   count(*) filter(where valid_cost and estimated_roi_pct<0)::integer losers
  from pi.closed_position_roi where wallet=$1 and generation=$2
 `,[address,state.generation]);
 const rows=await db.unsafe(`
  select token_id,condition_id,title,outcome,market_slug,
   first_entry_at::text,last_event_at::text,
   lifetime_shares::double precision shares,avg_entry_price::double precision price,
   estimated_entry_cost_usdc::double precision cost,
   realized_pnl_usdc::double precision pnl,estimated_roi_pct::double precision roi,
   valid_cost,quality_reason
  from pi.closed_position_roi
  where wallet=$1 and generation=$2
  order by last_event_at desc nulls last,token_id
  limit $3 offset $4
 `,[address,state.generation,per,(page-1)*per]);
 return {state,summary:summaryRows[0]??null,rows,page,per,
  method:"Estimated closed outcome ROI: lifetime bought shares × average acquisition price. Fees/transfers not reconciled; not capital ROI or individual fill ROI."};
}
async function requestPositionRoi(body:any){
 const wallet=s(body.wallet,50).toLowerCase();
 if(!walletPattern.test(wallet))return send({error:"Wallet invalide"},400);
 const known=await db.unsafe("select 1 from pi.wallets where wallet=$1",[wallet]);
 if(!known.length)return send({error:"Wallet non suivi"},404);
 const audit=body.force===true;
 const row=await db.unsafe(`
  insert into pi.roi_import_state(wallet,request_priority)
  values ($1,true)
  on conflict(wallet) do update set
   sync_mode=case when pi.roi_import_state.sync_mode='idle'
                  then case when $2::boolean then 'full' else 'recent' end
                  else pi.roi_import_state.sync_mode end,
   exhausted=case when pi.roi_import_state.sync_mode='idle'
                  then false else pi.roi_import_state.exhausted end,
   next_cursor=case when pi.roi_import_state.sync_mode='idle'
                    then null else pi.roi_import_state.next_cursor end,
   scan_started_at=case when pi.roi_import_state.sync_mode='idle'
                        then now() else pi.roi_import_state.scan_started_at end,
   checkpoint_at=case when pi.roi_import_state.sync_mode='idle'
                      then now()-interval '14 days' else pi.roi_import_state.checkpoint_at end,
   pages_fetched=case when pi.roi_import_state.sync_mode='idle' then 0
                      else pi.roi_import_state.pages_fetched end,
   rows_seen=case when pi.roi_import_state.sync_mode='idle' then 0
                  else pi.roi_import_state.rows_seen end,
   request_priority=true,
   last_attempt_at=case when pi.roi_import_state.sync_mode='idle'
                        then null else pi.roi_import_state.last_attempt_at end,
   consecutive_failures=0,last_error=null,updated_at=now()
  returning wallet,sync_mode,pages_fetched
 `,[wallet,audit]);
 return {queued:true,mode:row[0].sync_mode,pages_fetched:row[0].pages_fetched};
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
 (select count(*)::integer from pi.closed_position_roi) roi_positions,
 (select count(*)::integer from pi.roi_import_state where last_complete_at is not null) roi_with_full_baseline,
 (select count(*)::integer from pi.roi_import_state where sync_mode<>'idle') roi_syncing,
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
  const origin=req.headers.get("origin");
  if(origin && origin!==SITE_ORIGIN) return send({error:"Origin non autorisée"},403);
  if(req.method==="OPTIONS"){
    return new Response(null,{status:204,headers:jsonHeaders});
  }
  if(req.method==="GET"){
    // Supabase rewrites HTML responses to text/plain on non-custom domains.
    // Public configuration contains ONLY project URL and publishable key.
    if(new URL(req.url).searchParams.get("config")==="1")
      return send({supabase_url:url,publishable_key:pub});
    return Response.redirect(SITE,302);
  }
 if(req.method!=="POST")return send({error:"Method not allowed"},405);
 if(Number(req.headers.get("content-length")||0)>6000)return send({error:"Payload too large"},413);
 try{
  if(!await allowed(req))return send({error:"Session non autorisée"},401);
  const body=await req.json();
  if(body?.action==="overview")return send(await overview());
  if(body?.action==="leaderboard")return send(await leaderboard(body));
  if(body?.action==="wallet")return send(await wallet(body));
  if(body?.action==="roi")return send(await positionRoi(body));
  if(body?.action==="roi_request")return send(await requestPositionRoi(body));
  if(body?.action==="health")return send(await health());
  return send({error:"Action inconnue"},400);
 }catch(e){
  console.error("pi-dashboard",e instanceof Error?e.message.slice(0,160):"unknown");
  return send({error:"Erreur lors de la lecture des données"},500);
 }
});
