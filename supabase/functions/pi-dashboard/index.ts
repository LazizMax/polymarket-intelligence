// Authenticated Polymarket Intelligence web API, read-only analytics.
import postgres from "npm:postgres@3.4.3";
import {quotePair} from "./arb-math.ts";
import {replayTemporal,type TemporalSample} from "./arb-temporal.ts";
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

// Read-only live scanner. Gross paired costs are snapshots, NOT executable promises.
// Maker rebates are intentionally ignored; fee reserve is user-supplied, not actual fees.
function asArray(x:unknown):unknown[]{
 if(Array.isArray(x))return x;
 if(typeof x==="string"){try{const a=JSON.parse(x);return Array.isArray(a)?a:[]}catch{return []}}
 return [];
}
async function arbitrage(body:any){
 const shares=number(body.shares,50,1,1000),feeReservePct=number(body.fee_reserve_pct,4,0,15);
 const limit=Math.round(number(body.limit,30,5,50));
 const g=new URL("https://gamma-api.polymarket.com/markets");
 for(const [k,v] of Object.entries({active:"true",closed:"false",limit:String(limit),order:"volume24hr",ascending:"false"}))
  g.searchParams.set(k,v);
 const response=await fetch(g,{headers:{accept:"application/json"},signal:AbortSignal.timeout(11000),cache:"no-store"});
 if(!response.ok)throw Error("Gamma HTTP "+response.status);
 const markets=await response.json();
 if(!Array.isArray(markets))throw Error("Unexpected Gamma response");
 const selected:any[]=[];
 for(const m of markets){
  if(!m||m.closed===true||m.active===false||m.enableOrderBook===false)continue;
  const names=asArray(m.outcomes).map(x=>String(x).toLowerCase());
  const tokens=asArray(m.clobTokenIds).map(x=>String(x));
  if(tokens.length!==2||names.length!==2||names[0]!=="yes"||names[1]!=="no"||tokens[0]===tokens[1])continue;
  if(!tokens.every(x=>/^\d{20,90}$/.test(x)))continue;
  selected.push({tokens,question:String(m.question||"").slice(0,220),slug:String(m.slug||"").slice(0,140),
    event_slug:String(Array.isArray(m.events)?m.events[0]?.slug||"":"" ).slice(0,180),
    condition_id:String(m.conditionId||"").slice(0,100),volume_24h:Number(m.volume24hr||0)});
 }
 const params=selected.flatMap(m=>m.tokens.map((token_id:string)=>({token_id})));
 if(!params.length)return {rows:[],markets_seen:markets.length,binary_scanned:0,
  fully_quoted:0,shares,fee_reserve_pct:feeReservePct,asof:new Date().toISOString(),
  warning:"Aucun marché binaire YES/NO trouvé dans ce lot. Aucune conclusion sur la présence d'arbitrages."};
 const bookResponse=await fetch("https://clob.polymarket.com/books",{
  method:"POST",headers:{accept:"application/json","content-type":"application/json"},
  body:JSON.stringify(params),signal:AbortSignal.timeout(12000),cache:"no-store"
 });
 if(!bookResponse.ok)throw Error("CLOB HTTP "+bookResponse.status);
 const bookList=await bookResponse.json();
 if(!Array.isArray(bookList))throw Error("Unexpected CLOB books response");
 const books=new Map<string,any>();
 for(const book of bookList)if(book&&typeof book.asset_id==="string")books.set(book.asset_id,book);
 const rows=[];
 for(const m of selected){
  const yes=books.get(m.tokens[0]),no=books.get(m.tokens[1]);
  if(!yes||!no)continue;
  const minSize=Math.max(Number(yes.min_order_size||0),Number(no.min_order_size||0));
  if(!Number.isFinite(minSize)||shares<minSize)continue;
  const q=quotePair(yes.asks,no.asks,shares,feeReservePct);
  if(!q)continue; // liquidity to fill both legs is mandatory
  rows.push({...q,question:m.question,slug:m.slug,event_slug:m.event_slug,condition_id:m.condition_id,volume_24h:m.volume_24h,
    yes_book_time:yes.timestamp||null,no_book_time:no.timestamp||null});
 }
 rows.sort((a,b)=>b.indicative_roi_pct-a.indicative_roi_pct);
 return {rows,markets_seen:markets.length,binary_scanned:selected.length,fully_quoted:rows.length,
  shares,fee_reserve_pct:feeReservePct,asof:new Date().toISOString(),
  warning:"Instantaneous book snapshots only. Prices can disappear; no atomic two-leg execution, and the selected fee reserve is not a Polymarket fee quote. No live orders."};
}



async function arbObservatory(){
 // Diagnostic quotes only. A spread, price drift or sum of bids DOES NOT imply an executable strategy.
 const items=await db.unsafe(`
 select observed_at::text as observed_at,market_key,market_slug,event_slug,question,
  quote_shares::float8 as quote_shares,yes_best_bid::float8 as yes_bid,yes_best_ask::float8 as yes_ask,
  no_best_bid::float8 as no_bid,no_best_ask::float8 as no_ask,
  yes_buy_avg::float8 as yes_buy_avg,no_buy_avg::float8 as no_buy_avg
 from pi.arb_temporal_snapshots
 where observed_at >= now()-interval '48 hours'
 order by observed_at desc,snapshot_id desc limit 3800
 `);
 const stats=new Map<string,any>();
 for(const x of items){
  if(!stats.has(x.market_key))stats.set(x.market_key,{
   key:x.market_key,question:x.question,event_slug:x.event_slug||null,market_slug:x.market_slug,
   first_at:x.observed_at,last_at:x.observed_at,observations:0,
   yes_bid:x.yes_bid,yes_ask:x.yes_ask,no_bid:x.no_bid,no_ask:x.no_ask,
   weighted_yes_buy:x.yes_buy_avg,weighted_no_buy:x.no_buy_avg,
   first_yes_ask:x.yes_ask,
   quote_shares:x.quote_shares,complete_bbo:0});
  const a=stats.get(x.market_key);
  a.observations++;
  a.first_at=x.observed_at;a.first_yes_ask=x.yes_ask;
  if(x.yes_bid!==null&&x.yes_ask!==null&&x.no_bid!==null&&x.no_ask!==null)a.complete_bbo++;
  // Backfill the most recent known *event* slug; never invent a /event/ URL from a market slug.
  if(!a.event_slug&&x.event_slug)a.event_slug=x.event_slug;
 }
 const computed=[...stats.values()].map(x=>{
  const valid=(v:unknown)=>v!==null&&v!==undefined&&Number.isFinite(Number(v));
  const yesSpread=valid(x.yes_ask)&&valid(x.yes_bid)?x.yes_ask-x.yes_bid:null;
  const noSpread=valid(x.no_ask)&&valid(x.no_bid)?x.no_ask-x.no_bid:null;
  const askSum=valid(x.weighted_yes_buy)&&valid(x.weighted_no_buy)?x.weighted_yes_buy+x.weighted_no_buy:null;
  const drift=valid(x.yes_ask)&&valid(x.first_yes_ask)?x.yes_ask-x.first_yes_ask:null;
  return {...x,yes_spread:yesSpread,no_spread:noSpread,
   weighted_ask_pair:askSum,yes_ask_drift:drift,
   duration_minutes:(Date.parse(x.last_at)-Date.parse(x.first_at))/60000,
   quote_quality: x.observations>=12&&x.complete_bbo>=12?"descriptive_only":"insufficient_observations"};
 });
 computed.sort((a,b)=>b.observations-a.observations);
 const last=await db.unsafe(`
 select status,started_at::text as started_at,finished_at::text as finished_at,
 left(coalesce(error_message,''),120) as error
 from pi.ingestion_jobs where stream='arb_temporal' order by id desc limit 1
 `);
 return {markets:computed,history_rows:items.length,window_hours:48,
  last_observation_at:items[0]?.observed_at??null,last_job:last[0]??null,
  sampling_interval_minutes:10,truncated:items.length>=3800,
  disclaimer:"Observation uniquement : spread et variation de cotations ne sont PAS une rentabilité. Sans journal d'ordres, trades maker/taker, latence, file et risque d'inventaire, aucune EV n'est estimable."};
}

async function temporalResearch(body:any){
 const cfg={
  entryCeiling:number(body.entry_ceiling,.47,.05,.49),
  feeReservePct:number(body.fee_reserve_pct,2,0,10),
  minNetRoiPct:number(body.min_roi_pct,.5,0,10),
  maxHoldMinutes:Math.round(number(body.max_hold_minutes,120,10,1440))
 };
 // Read the newest bounded window. Older samples are never fabricated or extrapolated.
 const rows=await db.unsafe(`
  select observed_at::text,market_key,market_slug,event_slug,question,yes_token_id,no_token_id,
    quote_shares::double precision,yes_buy_avg::double precision,no_buy_avg::double precision,
    yes_sell_avg::double precision,no_sell_avg::double precision
  from pi.arb_temporal_snapshots
  where observed_at>=now()-interval '48 hours' and quote_shares=50
  order by observed_at desc,snapshot_id desc limit 3800
 `);
 const audit=await db.unsafe(`
 select status,started_at::text,finished_at::text,rows_fetched,left(coalesce(error_message,''),120) error
 from pi.ingestion_jobs where stream='arb_temporal' order by id desc limit 1
 `);
 const result=replayTemporal([...rows].reverse() as unknown as TemporalSample[],cfg);
 return {config:cfg,quantity:50,poll_minutes:10,window_hours:48,
  truncated:rows.length>=3800,last_observation_at:rows[0]?.observed_at??null,
  last_job:audit[0]??null,...result,
  disclaimer:"Contrefactuel taker sur instantanés échantillonnés; aucune exécution confirmée, aucun gain réel, aucune capture maker validée. Les book snapshots séparés de 10 min ne prouvent pas les prix accessibles."};
}


const RN1="0x2005d16a84ceefa912d4e380cd32e7ff827875ea";


async function rn1StrategyEvidence(){
 // Strictly source-observed facts vs explicit buy-and-hold counterfactual.
 // A historical one-minute price point is NOT a contemporaneous executable bid/ask.
 const counts=await db.unsafe(`
 select (select count(*)::int from pi.rn1_resolution_evidence) resolution_markets_checked,
 (select count(*)::int from pi.rn1_resolution_evidence
   where status='resolved' and jsonb_typeof(payouts)='array'
   and jsonb_array_length(payouts)=2
   and (payouts->>0)::numeric+(payouts->>1)::numeric=1000000) settled_markets,
 (select count(*)::int from pi.rn1_price_history_evidence where request_status='ok') token_histories,
 (select count(*)::int from pi.rn1_historical_price_points) observed_price_points,
 (select count(*)::int from pi.rn1_fill_price_benchmark where wallet=$1) benchmarked_buys,
 (select count(distinct market_key)::int from pi.rn1_fill_price_benchmark where wallet=$1) benchmarked_markets
 `,[RN1]);
 const hold=await db.unsafe(`
 with m as(
  select t.market_key,
  sum(t.shares*t.price) as cost,
  sum(t.shares) filter(where t.outcome_index=0) q0,
  sum(t.shares) filter(where t.outcome_index=1) q1,
  sum(t.shares*t.price) filter(where t.outcome_index=0) c0,
  sum(t.shares*t.price) filter(where t.outcome_index=1) c1,
  count(*)::int fills,
  (r.payouts->>0)::numeric/1000000 as p0,
  (r.payouts->>1)::numeric/1000000 as p1
  from pi.trades t join pi.rn1_resolution_evidence r on t.market_key=r.market_key
  where t.wallet=$1 and t.side='BUY' and t.reported_at<r.resolved_at
   and r.status='resolved' and jsonb_typeof(r.payouts)='array'
   and jsonb_array_length(r.payouts)=2
   and (r.payouts->>0)::numeric+(r.payouts->>1)::numeric=1000000
  group by t.market_key,r.payouts
 ),
 v as(
  select *,
   coalesce(q0,0)*p0+coalesce(q1,0)*p1 as payout,
   case when q0>0 and q1>0
    then least(q0,q1)*(1-c0/q0-c1/q1) else 0 end as pair_component
  from m
 )
 select count(*)::int markets,sum(fills)::int fills,
 sum(cost)::float8 as buy_cost,
 sum(payout)::float8 as hypothetical_payout,
 sum(payout-cost)::float8 as hypothetical_gross_pnl,
 sum(pair_component)::float8 as pairing_component,
 sum(payout-cost-pair_component)::float8 as directional_residual
 from v`,[RN1]);
 const tiers=await db.unsafe(`
 with ranked as(
  select market_key,row_number() over(order by sum(shares*fill_price) desc,market_key) as pos
  from pi.rn1_fill_price_benchmark where wallet=$1 group by market_key
 ), fills as (
  select b.*,case when r.pos<=20 then 'top20' else 'next60' end as segment
  from pi.rn1_fill_price_benchmark b join ranked r on r.market_key=b.market_key
  where b.wallet=$1
 )
 select coalesce(segment,'total') segment,
 count(*)::int fills,count(distinct market_key)::int markets,
 count(*) filter(where reference_price is not null)::int referenced,
 count(*) filter(where after_15m_price is not null)::int forward_15m,
 sum(shares*fill_price)::float8 as buy_cost,
 sum(shares*(payout_per_share-fill_price))::float8 as hypothetical_gross_pnl,
 sum(shares*(reference_price-fill_price))::float8 as execution_vs_stale_reference,
 sum(shares*(payout_per_share-reference_price))::float8 as outcome_vs_stale_reference,
 sum(shares*(after_15m_price-fill_price))::float8 as markout_15m,
 100.0*count(*) filter(where after_15m_price>fill_price)
 /nullif(count(*) filter(where after_15m_price is not null),0) as favorable_markout_pct,
 avg(extract(epoch from bought_at)-(reference_epoch+coalesce(reference_width_seconds,0)))
 filter(where reference_epoch is not null)::float8 as avg_reference_age_seconds
 from fills group by rollup(segment) order by segment`,[RN1]);
 const first=await db.unsafe(`
 with ranked as(
  select b.*,row_number() over(partition by b.market_key order by b.bought_at,b.trade_key) rn
  from pi.rn1_fill_price_benchmark b where b.wallet=$1
 )
 select count(*)::int markets,count(distinct t.event_slug)::int distinct_events,
 sum(b.payout_per_share)::float8 as first_side_winners,
 sum(b.reference_price)::float8 as expected_winners_from_prices,
 sum(b.payout_per_share-b.reference_price)::float8 as excess_winners,
 sqrt(sum(b.reference_price*(1-b.reference_price)))::float8 as naive_independent_sd
 from ranked b join pi.trades t on t.wallet=b.wallet and t.trade_key=b.trade_key
 where b.rn=1 and b.reference_price is not null`,[RN1]);
 const examples=await db.unsafe(`
 select b.market_key,(array_agg(nullif(t.market_title,'') order by b.bought_at desc))[1] market_title,
 (array_agg(nullif(t.event_slug,'') order by b.bought_at desc))[1] event_slug,
 count(*)::int fills,sum(b.shares*b.fill_price)::float8 as buy_cost,
 sum(b.shares*(b.payout_per_share-b.fill_price))::float8 as hypothetical_gross_pnl,
 sum(b.shares*(b.after_15m_price-b.fill_price))::float8 as markout_15m
 from pi.rn1_fill_price_benchmark b
 join pi.trades t on t.wallet=b.wallet and t.trade_key=b.trade_key
 where b.wallet=$1
 group by b.market_key order by sum(b.shares*b.fill_price) desc limit 10`,[RN1]);
 return {count:counts[0]||{},hold:hold[0]||{},tiers,first_selection:first[0]||{},examples,
  quality:"research_only_not_validated_alpha",
  time_window:"2026-11-12 to 2026-11-15 UTC; latest-first 4,000-trade pilot",
  caveats:[
   "Buy-and-hold PnL is hypothetical. Actual inventory, merges, redemptions, transfers, prior purchases, incentives and fees are not fully reconciled.",
   "The price series provides historical observations, not bid/ask, execution priority or an independently executable price. A one-minute bucket ending before each trade is used; the reference is on average about 31 seconds old.",
   "The 80 highest-notional sampled markets represent a biased selection. They share only 26 distinct sporting events; individual fills are not independent predictions.",
   "Maker/taker identity, proprietary sports probabilities and contemporaneous bookmaker odds remain unverified."
  ]};
}

async function rn1ActivityResearch(){
 const state=await db.unsafe(`
  select status,pages_fetched,rows_seen,rows_stored,missing_required,sample_limit,
    last_success_at::text,last_error
  from pi.rn1_activity_import_state where wallet=$1`,[RN1]);
 const types=await db.unsafe(`
  select kind,count(*)::integer as events,
   sum(reported_usdc_size)::double precision as reported_usdc_size_total,
   count(*) filter(where reported_usdc_size is null)::integer as missing_reported_amount,
   count(*) filter(where tx_hash is null)::integer as missing_txhash,
   min(occurred_at)::text as earliest,max(occurred_at)::text as latest
  from pi.wallet_activity where wallet=$1 group by kind order by events desc,kind`,[RN1]);
 const coverage=await db.unsafe(`
  select count(*)::integer as activity_rows,
   count(*) filter(where a.kind='TRADE')::integer as activity_trade_rows,
   count(*) filter(where a.kind='TRADE' and exists(
     select 1 from pi.trades t where t.wallet=a.wallet and t.tx_hash=a.tx_hash
      and t.token_id=a.token_id and t.side=a.side
      and abs(t.shares-a.shares)<0.00001 and abs(t.price-a.unit_price)<0.00001
   ))::integer as activity_trade_rows_with_matching_trade,
   count(*) filter(where a.kind='REDEEM')::integer as redemptions,
   count(*) filter(where a.kind='REDEEM' and exists(
     select 1 from pi.trades t where t.wallet=a.wallet and t.market_key=a.market_key and t.token_id=a.token_id
   ))::integer as redemptions_with_some_observed_buy_or_sell
  from pi.wallet_activity a where a.wallet=$1`,[RN1]);

 const windows=await db.unsafe(`
 select
 (select min(reported_at)::text from pi.trades where wallet=$1) as trades_oldest,
 (select max(reported_at)::text from pi.trades where wallet=$1) as trades_newest,
 (select min(occurred_at)::text from pi.wallet_activity where wallet=$1) as activity_oldest,
 (select max(occurred_at)::text from pi.wallet_activity where wallet=$1) as activity_newest
 `,[RN1]);

 const recent=await db.unsafe(`
  select occurred_at::text as at,kind,market_title,event_slug,market_key,token_id,
   side,shares::double precision,unit_price::double precision,
   reported_usdc_size::double precision,tx_hash
  from pi.wallet_activity where wallet=$1 and kind<>'TRADE'
  order by occurred_at desc,activity_key desc limit 35`,[RN1]);
 const perMarket=await db.unsafe(`
  select a.market_key,(array_agg(nullif(a.market_title,'') order by a.occurred_at desc))[1] as title,
   (array_agg(nullif(a.event_slug,'') order by a.occurred_at desc))[1] as event_slug,
   count(*) filter(where kind='TRADE')::int as trades_in_activity,
   count(*) filter(where kind='REDEEM')::int as redemptions,
   count(*) filter(where kind='MERGE')::int as merges,
   sum(a.reported_usdc_size) filter(where kind='REDEEM')::double precision as reported_redeem_usdc
  from pi.wallet_activity a where wallet=$1 and a.market_key is not null
  group by a.market_key
  having count(*) filter(where kind<>'TRADE')>0
  order by redemptions desc,merges desc,a.market_key limit 30`,[RN1]);
 return {
  import_state:state[0]||null,coverage:coverage[0]||{},windows:windows[0]||{},types,recent,markets:perMarket,
  reconciliation_status:"unreconciled",
  disclaimers:[
   "REDEEM denotes a reported payout, NOT profit. Basis/cost, transfers and prior inventory may be outside both samples.",
   "A TRADE recorded in both feeds is one economic trade, not two independent trades. Exact matching by attributes only establishes correspondence, not fill identity.",
   "Source reported USDC amount is kept separately from net PnL; rewards/fees cannot be attributed to a market without evidence.",
   "No merge, redemption, or rebate absence is inferred from incomplete recent-first data; historical source windows can differ."
  ]};
}

async function rn1Research(){
 const stat=await db.unsafe(`
  select wallet,status,pages_fetched,rows_seen,rows_stored,missing_required,sample_limit,
  last_success_at::text,last_error,updated_at::text
  from pi.rn1_trade_import_state where wallet=$1`,[RN1]);
 const summary=await db.unsafe(`
  select count(*)::int as trades,count(*) filter(where side='BUY')::int buys,
  count(*) filter(where side='SELL')::int sells,
  count(distinct market_key)::int markets,
  count(distinct tx_hash)::int transaction_hashes,
  sum(observed_notional_usdc)::double precision as traded_notional_usdc,
  min(reported_at)::text as first_trade_at,max(reported_at)::text as last_trade_at
  from pi.trades where wallet=$1`,[RN1]);
 const two=await db.unsafe(`
 with market_buys as(
  select market_key,
  sum(shares) filter(where side='BUY' and outcome_index=0) qty0,
  sum(shares) filter(where side='BUY' and outcome_index=1) qty1,
  sum(price*shares) filter(where side='BUY' and outcome_index=0) cost0,
  sum(price*shares) filter(where side='BUY' and outcome_index=1) cost1,
  count(*) filter(where side='BUY') buys,
  count(*) filter(where side='SELL') sells,
  min(reported_at) filter(where side='BUY' and outcome_index=0) first0,
  min(reported_at) filter(where side='BUY' and outcome_index=1) first1
  from pi.trades where wallet=$1
  group by market_key
 )
 select count(*) filter(where qty0>0 and qty1>0)::int as both_issues_observed,
 count(*) filter(where qty0>0 or qty1>0)::int as at_least_one,
 percentile_cont(.5) within group(order by abs(extract(epoch from(first1-first0)))/60)
  filter(where qty0>0 and qty1>0) as median_first_buy_lag_minutes
 from market_buys`,[RN1]);
 const markets=await db.unsafe(`
 with groups as(
  select market_key,
   (array_agg(nullif(market_title,'') order by reported_at desc))[1] market_title,
   (array_agg(nullif(event_slug,'') order by reported_at desc))[1] event_slug,
   count(*)::int fills,
   count(*) filter(where side='BUY')::int buys,
   count(*) filter(where side='SELL')::int sells,
   sum(shares) filter(where side='BUY' and outcome_index=0)::float8 qty0,
   sum(shares) filter(where side='BUY' and outcome_index=1)::float8 qty1,
   (sum(price*shares) filter(where side='BUY' and outcome_index=0)/
      nullif(sum(shares) filter(where side='BUY' and outcome_index=0),0))::float8 as vwap0,
   (sum(price*shares) filter(where side='BUY' and outcome_index=1)/
      nullif(sum(shares) filter(where side='BUY' and outcome_index=1),0))::float8 as vwap1,
   min(reported_at) filter(where side='BUY' and outcome_index=0) as first0,
   min(reported_at) filter(where side='BUY' and outcome_index=1) as first1
  from pi.trades where wallet=$1 group by market_key
 )
 select market_key,market_title,event_slug,fills,buys,sells,qty0,qty1,vwap0,vwap1,
  case when first0 is not null and first1 is not null then
    abs(extract(epoch from(first1-first0)))/60 else null end::float8 as first_buy_lag_minutes,
  (qty0>0 and qty1>0) as both_issues
 from groups order by fills desc,market_key limit 30`,[RN1]);
 const recent=await db.unsafe(`
 select reported_at::text as at,market_title,event_slug,side,outcome_label,
 outcome_index,price::float8,shares::float8,observed_notional_usdc::float8,tx_hash
 from pi.trades where wallet=$1 order by reported_at desc,trade_key desc limit 25`,[RN1]);
 return {wallet:RN1,import_state:stat[0]||null,summary:summary[0]||{},both_issues:two[0]||{},
   markets,recent,scope:"Latest-first sample of observed public trades, not complete trading history.",
   limitations:["Individual maker/taker role unavailable in the public V2 trade feed.",
    "An on-chain transaction hash can contain multiple fills; page and row identity is preserved in private raw archives.",
    "Opposing BUYs do not prove a locked hedge: positions may be sold, redeemed, merged, transferred, or partially filled.",
    "No realized PnL, fees, incentives, trade profitability, or verified matched-pair economics are computed from these trades.",
    "First-observed BUY lag is NOT the trader's true hedge latency if earlier trades are outside the sample."]};
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
  if(body?.action==="arbitrage")return send(await arbitrage(body));
  if(body?.action==="arb_temporal")return send(await temporalResearch(body));
  if(body?.action==="arb_observatory")return send(await arbObservatory());
  if(body?.action==="rn1_research")return send(await rn1Research());
  if(body?.action==="rn1_strategy_evidence")return send(await rn1StrategyEvidence());
  if(body?.action==="rn1_activity_research")return send(await rn1ActivityResearch());
  return send({error:"Action inconnue"},400);
 }catch(e){
  console.error("pi-dashboard",e instanceof Error?e.message.slice(0,160):"unknown");
  return send({error:"Erreur lors de la lecture des données"},500);
 }
});
