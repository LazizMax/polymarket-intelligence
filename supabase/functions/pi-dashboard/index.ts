// Authenticated Polymarket Intelligence web API, read-only analytics.
import postgres from "npm:postgres@3.4.3";
import {quotePair} from "./arb-math.ts";
import {replayTemporal,type TemporalSample} from "./arb-temporal.ts";
const url = "https://bxfvgywfiifnsbjgudzj.supabase.co"; // legacy identity provider for existing login
const pub = "sb_publishable_CIPlaX8vTlmMDbLCBbtprA_A0aIUujT"; // public key of legacy identity provider; no service-role access
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
 const rows=await db.unsafe("select enabled from pi.external_dashboard_access where user_id=$1::uuid and enabled=true",[user.id]);
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





async function rn1QuoteForensics(){
 const state=await db.unsafe(`
 select status,completed_runs::float8 as completed_runs,
 matched_fills::float8 as matched_fills,
 archived_gzip_bytes::float8 as archived_gzip_bytes,
 last_success_at::text as last_success_at,last_error,
 max_db_bytes::float8 as max_db_bytes
 from pi.rn1_quote_probe_state where singleton=true`);
 const current=await db.unsafe(`
 select id,received_at::text as received_at,market_count,book_count,rn1_market_count,
 quotes from pi.rn1_quote_probe_runs order by received_at desc limit 1`);
 const bookPairs=await db.unsafe(`
 with per_side as(
  select r.id,r.received_at,
   x->>'market_key' as market_key,
   (x->>'outcome_index')::int outcome,
   (x->>'bid')::numeric as bid,(x->>'ask')::numeric as ask,
   (x->>'bid_size')::numeric as bid_size,
   (x->>'ask_size')::numeric as ask_size
  from pi.rn1_quote_probe_runs r
  cross join lateral jsonb_array_elements(r.quotes) x
  where r.received_at>=now()-interval '14 days'
   and (x->>'book_valid')::boolean=true
 ), paired as(
  select id,market_key,
   max(bid) filter(where outcome=0) bid0,
   max(bid) filter(where outcome=1) bid1,
   max(ask) filter(where outcome=0) ask0,
   max(ask) filter(where outcome=1) ask1,
   max(ask_size) filter(where outcome=0) ask_size0,
   max(ask_size) filter(where outcome=1) ask_size1
  from per_side group by id,market_key
 )
 select count(*)::int total_book_pairs,
 count(distinct market_key)::int markets,
 count(*) filter(where bid0 is not null and bid1 is not null
  and ask0 is not null and ask1 is not null)::int valid_book_pairs,
 count(*) filter(where bid0+bid1<1)::int
  resting_two_bid_sum_below_one,
 count(*) filter(where ask0+ask1<1)::int
  buying_two_asks_sum_below_one_before_fees,
 count(*) filter(where ask0+ask1+
  0.05*ask0*(1-ask0)+0.05*ask1*(1-ask1)<1
  and least(ask_size0,ask_size1)>=5)::int
  buying_two_asks_after_sports_fee_and_depth,
 avg(1-(bid0+bid1))::float8 mean_unfilled_maker_pair_gap,
 avg(1-(ask0+ask1))::float8 mean_crossing_ask_pair_gap
 from paired`);
 const fills=await db.unsafe(`
 with verified as(
  select f.*,r.quotes as matched_quotes
  from pi.rn1_quote_probe_fills f join pi.rn1_quote_probe_runs r on r.id=f.run_id
 )
 select count(*)::int matched_fills,
 count(distinct market_key)::int matched_markets,
 count(distinct trade_at::date)::int matched_days,
 count(*) filter(where role='maker_inferred')::int inferred_maker_fills,
 count(*) filter(where role='taker_verified')::int verified_taker_fills,
 count(*) filter(where role='unknown')::int unknown_role_fills,
 count(*) filter(where lag_seconds<=30)::int matched_under_30s,
 count(*) filter(where lag_seconds>30 and lag_seconds<=60)::int matched_30to60s,
 count(*) filter(where lag_seconds>60)::int matched_over60s,
 count(*) filter(where role='maker_inferred' and lag_seconds<=30)::int maker_recent_under30,
 count(*) filter(where role='maker_inferred' and lag_seconds<=30
  and abs(bid_offset_ticks)<=0.5)::int maker_at_bid_under30,
 count(*) filter(where role='maker_inferred' and lag_seconds>30
  and lag_seconds<=60)::int maker_recent_30to60,
 count(*) filter(where role='maker_inferred' and lag_seconds>30
  and lag_seconds<=60 and abs(bid_offset_ticks)<=0.5)::int maker_at_bid_30to60,
 count(*) filter(where role='maker_inferred' and lag_seconds<=60
  and abs(bid_offset_ticks)<=0.5)::int maker_fills_at_prior_bid,
 count(*) filter(where role='maker_inferred' and lag_seconds<=60)::int
  maker_fills_close_enough_to_compare,
 avg(abs(bid_offset_ticks)) filter(where role='maker_inferred'
  and lag_seconds<=60)::float8 avg_maker_offset_ticks_abs,
 coalesce(sum(sports_taker_fee_estimate) filter(where role='taker_verified'),0)::float8
  estimated_matched_taker_fees
 from verified`);
 const models=await db.unsafe(`
 with classified as(
  select *,
   min(trade_at) over() as min_time,max(trade_at) over() as max_time
  from pi.rn1_quote_probe_fills
  where role='maker_inferred' and lag_seconds<=60
 ), grouped as(
  select case when trade_at >=
   min_time+(max_time-min_time)*0.8 then 'holdout' else 'train' end period,
   market_key,bid_offset_ticks from classified
 )
 select period,count(*)::int fills,count(distinct market_key)::int markets,
 avg(abs(bid_offset_ticks))::float8 best_bid_mae_ticks,
 avg(abs(bid_offset_ticks+1))::float8 one_tick_below_mae_ticks,
 avg(abs(bid_offset_ticks+2))::float8 two_ticks_below_mae_ticks,
 avg(abs(bid_offset_ticks-1))::float8 one_tick_above_mae_ticks
 from grouped group by period order by period`);

 const markouts=await db.unsafe(`
 -- Observational, fill-conditional mark-to-mid, NOT realized PnL.
 -- Each post-trade book is recorded after the fill; books stale by their own
 -- timestamps are rejected. Later horizons may include different fills.
 with fills as(
  select fingerprint,market_key,token_id,trade_at,fill_price,pre_mid,shares
  from pi.rn1_quote_probe_fills
  where role='maker_inferred' and side='BUY'
 ), horizons as(
  select 'short' horizon,30 lo,120 hi
  union all select 'medium',180,420
  union all select 'long',600,1200
 ), matched as(
  select f.*,h.horizon,r.received_at post_at,
   (j->>'mid')::numeric post_mid,
   row_number() over(
    partition by f.fingerprint,h.horizon order by r.received_at
   ) rn
  from fills f cross join horizons h
  join pi.rn1_quote_probe_runs r
   on r.received_at between f.trade_at+h.lo*interval '1 second'
    and f.trade_at+h.hi*interval '1 second'
  cross join lateral jsonb_array_elements(r.quotes) j
  where j->>'asset_id'=f.token_id and j->>'book_valid'='true'
   and j->>'mid' is not null
   and (j->>'book_at')::numeric>=extract(epoch from f.trade_at)*1000
 ), first_post as(
  select * from matched where rn=1
 ), common as(
  select fingerprint from first_post
  group by fingerprint having count(distinct horizon)=3
 )
 select horizon,count(*)::int matched_fills,
  count(distinct market_key)::int markets,
  count(distinct trade_at::date)::int days,
  count(*) filter(where post_mid<fill_price)::int negative_markouts,
  avg(post_mid-fill_price)::float8 mean_markout_per_share,
  (sum(shares*(post_mid-fill_price))/nullif(sum(shares),0))::float8
   quantity_weighted_markout_per_share,
  avg(post_mid-pre_mid)::float8 mean_mid_change,
  count(*) filter(where fingerprint in(select fingerprint from common))::int
   same_fills_all_horizons,
  (sum(shares*(post_mid-fill_price)) filter(
    where fingerprint in(select fingerprint from common)
   )/nullif(sum(shares) filter(
    where fingerprint in(select fingerprint from common)
   ),0))::float8 same_fills_weighted_markout
 from first_post group by horizon order by horizon
 `);

 const inventoryCoverage=await db.unsafe(`
 select count(*)::int total_runs,
 count(*) filter(where position_status='complete'
  and position_observed_at is not null
  and position_observed_at<=requested_at)::int complete_position_runs,
 count(*) filter(where position_status='unavailable')::int unavailable_runs,
 coalesce(sum(jsonb_array_length(positions))
  filter(where position_status='complete'),0)::int checked_outcome_positions
 from pi.rn1_quote_probe_runs`);
 const inventoryObserved=await db.unsafe(`
 with holding as(
  select r.id run_id,p.market_key,p.token_id,p.outcome_index,p.current_size,p.avg_price
  from pi.rn1_quote_probe_runs r
  cross join lateral jsonb_to_recordset(r.positions)
  as p(market_key text,token_id text,outcome_index int,
       current_size numeric,avg_price numeric)
  where r.position_status='complete' and r.position_observed_at<=r.requested_at
 ), prior as(
  select f.market_key,f.role,f.fill_price,f.shares,f.lag_seconds,
  my.current_size own,opp.current_size other,opp.avg_price other_avg,
  (my.current_size-opp.current_size)/
   nullif(my.current_size+opp.current_size,0) signed_skew
  from pi.rn1_quote_probe_fills f
  join holding my on my.run_id=f.run_id and my.token_id=f.token_id
  join holding opp on opp.run_id=f.run_id and opp.market_key=my.market_key
   and opp.outcome_index<>my.outcome_index
  where f.role='maker_inferred' and f.side='BUY' and f.lag_seconds<=60
 )
 select case when own=0 and other=0 then 'empty'
  when own<other then 'underweight'
  when own>other then 'overweight'
  else 'balanced' end as pretrade_inventory_side,
 count(*)::int matched_fills,count(distinct market_key)::int markets,
 round(avg(abs(signed_skew))::numeric,4)::float8 avg_abs_skew,
 count(*) filter(where other>own and other_avg is not null
  and fill_price+other_avg<1)::int
  purchases_priced_below_previous_opposite_average,
 coalesce(sum(least(shares,greatest(0,other-own))*
  (1-fill_price-other_avg)) filter(where other>own and other_avg is not null),0)::float8
  indicative_incremental_pair_margin
 from prior group by 1 order by 1`);
 const inventoryTransitions=await db.unsafe(`
 -- Snapshot-to-snapshot change is observational, not a causal effect of a
 -- single fill: other trades, redeems or transfers may occur between captures.
 with before as(
  select f.fingerprint,f.market_key,f.token_id,f.trade_at,
   p.current_size own,opp.current_size other,
   abs(p.current_size-opp.current_size) imbalance_before
  from pi.rn1_quote_probe_fills f
  join pi.rn1_quote_probe_runs r on r.id=f.run_id
  cross join lateral jsonb_to_recordset(r.positions)
   as p(market_key text,token_id text,outcome_index int,current_size numeric)
  join lateral jsonb_to_recordset(r.positions)
   as opp(market_key text,token_id text,outcome_index int,current_size numeric)
   on opp.market_key=p.market_key and opp.outcome_index<>p.outcome_index
  where f.role='maker_inferred' and f.side='BUY'
   and r.position_status='complete'
   and r.position_observed_at<=r.requested_at
   and p.market_key=f.market_key and p.token_id=f.token_id
 ), later as(
  select b.*,r.position_observed_at as later_observed_at,
   p.current_size own_after,opp.current_size other_after,
   row_number() over(partition by b.fingerprint
    order by r.position_observed_at,r.id) rn
  from before b
  join pi.rn1_quote_probe_runs r on r.position_status='complete'
   and r.position_observed_at>b.trade_at
   and r.position_observed_at<=b.trade_at+interval '5 minutes'
  cross join lateral jsonb_to_recordset(r.positions)
   as p(market_key text,token_id text,outcome_index int,current_size numeric)
  join lateral jsonb_to_recordset(r.positions)
   as opp(market_key text,token_id text,outcome_index int,current_size numeric)
   on opp.market_key=p.market_key and opp.outcome_index<>p.outcome_index
  where p.market_key=b.market_key and p.token_id=b.token_id
 )
 select count(*)::int comparable_fills,
  count(distinct market_key)::int markets,
  count(distinct trade_at::date)::int days,
  count(*) filter(where abs(own_after-other_after)<imbalance_before)::int
   less_imbalanced,
  count(*) filter(where abs(own_after-other_after)>imbalance_before)::int
   more_imbalanced,
  count(*) filter(where abs(own_after-other_after)=imbalance_before)::int
   unchanged,
  avg(abs(own_after-other_after)-imbalance_before)::float8
   avg_imbalance_change_shares
 from later where rn=1
 `);
 const inventoryModels=await db.unsafe(`
 with pos as(
  select r.id run_id,p.market_key,p.token_id,p.outcome_index,
   p.current_size,p.avg_price
  from pi.rn1_quote_probe_runs r
  cross join lateral jsonb_to_recordset(r.positions)
  as p(market_key text,token_id text,outcome_index int,current_size numeric,avg_price numeric)
  where r.position_status='complete' and r.position_observed_at<=r.requested_at
 ), candidate as(
  select f.fingerprint,f.trade_at,f.fill_price,f.pre_bid,f.pre_ask,f.market_key,
   my.current_size own,opp.current_size other,opp.avg_price other_avg,
   (my.current_size-opp.current_size)/
    nullif(my.current_size+opp.current_size,0) signed_skew,
   (q->>'tick')::numeric tick,q->>'event_slug' event_slug
  from pi.rn1_quote_probe_fills f
  join pi.rn1_quote_probe_runs r on r.id=f.run_id
  join pos my on my.run_id=f.run_id and my.token_id=f.token_id
  join pos opp on opp.run_id=f.run_id and opp.market_key=my.market_key
   and opp.outcome_index<>my.outcome_index
  cross join lateral jsonb_array_elements(r.quotes) q
  where q->>'asset_id'=f.token_id and f.role='maker_inferred'
   and f.side='BUY' and f.lag_seconds<=60
   and opp.current_size>0 and opp.avg_price is not null
   and (q->>'tick')::numeric>0 and f.pre_ask>f.pre_bid
   -- All candidates are scored on the SAME price-eligible fills.
   -- Otherwise a model could appear better simply by excluding tough fills.
   and f.pre_bid>=3*(q->>'tick')::numeric
   and 1-opp.avg_price-.02 >= (q->>'tick')::numeric
 ), ranked as(
  select *,row_number() over(order by trade_at,fingerprint) rn,
   count(*) over() n from candidate
 ), candidates as(
  select
   case when rn<=floor(n*.8) then 'train' else 'holdout' end period,
   market_key,event_slug,fill_price,tick,
   pre_bid model_best_bid,
   pre_bid-tick model_one_tick_below,
   pre_bid-2*tick model_two_ticks_below,
   floor((pre_bid-tick*greatest(0,coalesce(signed_skew,0)))/tick)*tick
    model_inventory_one_tick,
   floor((pre_bid-2*tick*greatest(0,coalesce(signed_skew,0)))/tick)*tick
    model_inventory_two_ticks,
   floor(least(pre_bid,1-other_avg-.01)/tick)*tick
    model_pair_ceiling_1pct,
   floor(least(pre_bid,1-other_avg-.02)/tick)*tick
    model_pair_ceiling_2pct,
   pre_ask
  from ranked
 ), eligible as(
  -- Every pricing rule must be evaluated on exactly the same executions.
  -- A per-model validity filter would select easier fills for some rules.
  select * from candidates
  where least(model_best_bid,model_one_tick_below,model_two_ticks_below,
    model_inventory_one_tick,model_inventory_two_ticks,
    model_pair_ceiling_1pct,model_pair_ceiling_2pct)>=tick
   and greatest(model_best_bid,model_one_tick_below,model_two_ticks_below,
    model_inventory_one_tick,model_inventory_two_ticks,
    model_pair_ceiling_1pct,model_pair_ceiling_2pct)<pre_ask
 ), expanded as(
  select period,market_key,event_slug,fill_price,tick,model_name,model_price
  from eligible
  cross join lateral (values
    ('best_bid',model_best_bid),
    ('one_tick_below',model_one_tick_below),
    ('two_ticks_below',model_two_ticks_below),
    ('inventory_one_tick',model_inventory_one_tick),
    ('inventory_two_ticks',model_inventory_two_ticks),
    ('pair_ceiling_1pct',model_pair_ceiling_1pct),
    ('pair_ceiling_2pct',model_pair_ceiling_2pct)
  ) v(model_name,model_price)
 )
 select period,model_name,count(*)::int fills,
  count(distinct market_key)::int markets,
  count(distinct event_slug)::int events,
  avg(abs(fill_price-model_price)/tick)::float8 mae_ticks
 from expanded group by period,model_name order by period,model_name`);
 const latest=current[0]||null;
 return {
  state:state[0]||{},summary:bookPairs[0]||{},matches:fills[0]||{},models,markouts,
  inventory:{coverage:inventoryCoverage[0]||{},by_side:inventoryObserved,models:inventoryModels,transitions:inventoryTransitions[0]||{}},
  latest:latest?{
   received_at:latest.received_at,market_count:latest.market_count,
   book_count:latest.book_count,rn1_market_count:latest.rn1_market_count,
   markets:[...new Map((latest.quotes||[]).map((q:any)=>[
    q.market_key,{market_key:q.market_key,event_slug:q.event_slug,market_type:q.market_type,
     source:q.origin}])).values()]
  }:null,
  quality:"live_pretrade_book_samples_not_original_unfilled_orders",
  methodology:"CLOB REST /books, asset IDs from Gamma, authenticated private gzip archives. Only fills occurring 10–120 seconds AFTER a quote response are matched. Sports taker fees use the currently published public category formula. A quote match does not prove that RN1 posted that quote or that a simulated order would fill.",
  training:"Model comparison is conditional on maker-inferred fills; train=earlier 80% by observed time, holdout=later 20%. This tests price-offset prediction only, not trading profitability. Require many independent events and temporal robustness before interpreting rankings."
 };
}

async function rn1EconomicAttribution(){
 // Reconcile ONLY binary-like two-sided markets with on-chain-account settlement
 // flows whose reported USDC matches EITHER observed winning-side share count.
 // This is conditional gross trading cashflow, NOT total wallet PnL or net fees.
 const base=`
 with account as(
  select market_key,
   sum(reported_usdc_size) filter(where kind='REDEEM') redeemed,
   sum(reported_usdc_size) filter(where kind='MERGE') merged
  from pi.rn1_full_activity_metrics where kind in('REDEEM','MERGE')
  group by market_key
 ), eligible as(
  select b.market_key,b.event_slug,b.max_trade_at,
   b.buy0_shares,b.buy1_shares,b.buy0_cost,b.buy1_cost,
   coalesce(a.redeemed,0) redeemed,coalesce(a.merged,0) merged,
   coalesce(a.redeemed,0)+coalesce(a.merged,0) returned,
   least(abs(coalesce(a.redeemed,0)+coalesce(a.merged,0)-b.buy0_shares),
    abs(coalesce(a.redeemed,0)+coalesce(a.merged,0)-b.buy1_shares)) payout_mismatch
  from pi.rn1_full_market_metrics b left join account a using(market_key)
  where b.wallet='0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
   and b.min_trade_at>='2026-09-21T00:00:00+00'
   and b.max_trade_at<'2026-11-12T00:00:00+00'
   and b.buy0_shares>0 and b.buy1_shares>0
 ), checked as(
  select *,
   redeemed>0 and payout_mismatch<=1 as reconciled,
   buy0_cost+buy1_cost as invested,
   returned-buy0_cost-buy1_cost as gross,
   least(buy0_shares,buy1_shares) as paired_shares,
   least(buy0_shares,buy1_shares)*(buy0_cost/buy0_shares+buy1_cost/buy1_shares)
    as paired_invested,
   least(buy0_shares,buy1_shares)*(1-buy0_cost/buy0_shares-buy1_cost/buy1_shares)
    as paired_gross
  from eligible
 )
 `;
 const summary=await db.unsafe(base+`
 select count(*)::int eligible_markets,
  count(*) filter(where redeemed>0)::int markets_with_redemption,
  count(*) filter(where reconciled)::int reconciled_markets,
  count(*) filter(where redeemed>0 and not reconciled)::int mismatched_markets,
  count(*) filter(where redeemed=0)::int no_redemption_yet,
  count(distinct event_slug) filter(where reconciled)::int independent_events,
  coalesce(sum(invested) filter(where reconciled),0)::float8 invested,
  coalesce(sum(returned) filter(where reconciled),0)::float8 returned,
  coalesce(sum(gross) filter(where reconciled),0)::float8 gross,
  coalesce(sum(paired_gross) filter(where reconciled),0)::float8 paired_gross,
  coalesce(sum(gross-paired_gross) filter(where reconciled),0)::float8 residual_gross,
  coalesce(sum(paired_shares) filter(where reconciled),0)::float8 paired_shares,
  coalesce(sum(paired_invested) filter(where reconciled),0)::float8 paired_invested,
  coalesce(sum(invested-paired_invested) filter(where reconciled),0)::float8 residual_invested,
  count(*) filter(where reconciled and paired_gross>0)::int positive_pair_markets,
  count(*) filter(where reconciled and gross>0)::int profitable_markets,
  count(*) filter(where reconciled and merged>0)::int merger_markets
 from checked`);
 const weekly=await db.unsafe(base+`
 select date_trunc('week',max_trade_at)::date::text week,
  count(*)::int markets,
  sum(invested)::float8 invested,
  sum(gross)::float8 gross,
  sum(paired_gross)::float8 paired_gross,
  sum(gross-paired_gross)::float8 residual_gross
 from checked where reconciled
 group by 1 order by 1`);
 const skewImpact=await db.unsafe(base+`
 , skewed as(
  select *,greatest(buy0_shares,buy1_shares)/
   nullif(least(buy0_shares,buy1_shares),0) as ratio,
   case when buy0_shares>0 and buy1_shares>0
    then gross-paired_gross end as residual_gross
  from checked where reconciled
 ), bands as(
  select case when ratio<1.1 then 'below_1_1'
   when ratio<1.5 then 'between_1_1_and_1_5'
   when ratio<2 then 'between_1_5_and_2'
   else 'at_least_2' end as imbalance_band,*
  from skewed
 )
 select imbalance_band,count(*)::int markets,
 count(distinct event_slug)::int events,
 sum(gross)::float8 gross,sum(paired_gross)::float8 paired_gross,
 sum(residual_gross)::float8 residual_gross,
 count(*) filter(where gross>0)::int gross_positive_markets
 from bands group by 1 order by 1
 `);
 const official=await db.unsafe(`
 with official as(
  select c.market_key,
   (r.payouts->>0)::numeric/1000000 p0,
   (r.payouts->>1)::numeric/1000000 p1,
   c.frozen_buy0_shares q0,c.frozen_buy1_shares q1
  from pi.rn1_price_edge_cohort c join pi.rn1_resolution_evidence r using(market_key)
  where r.status='resolved' and jsonb_typeof(r.payouts)='array'
    and jsonb_array_length(r.payouts)=2
    and (r.payouts->>0)::numeric+(r.payouts->>1)::numeric=1000000
 ), settled as(
  select o.*,coalesce(sum(a.reported_usdc_size)
   filter(where a.kind in('REDEEM','MERGE')),0) as cash_return
  from official o left join pi.rn1_full_activity_metrics a
   on a.market_key=o.market_key
  group by o.market_key,o.p0,o.p1,o.q0,o.q1
 )
 select (select count(*)::int from pi.rn1_price_edge_cohort) sampled_markets,
  count(*)::int officially_binary_resolved,
  count(*) filter(where abs(cash_return-(q0*p0+q1*p1))<=0.01)::int
   matching_redeemed_within_cent,
  count(*) filter(where abs(cash_return-(q0*p0+q1*p1))<=1)::int
   matching_redeemed_within_dollar
 from settled`);
 const eventRisk=await db.unsafe(base+`
 , event as(
 select coalesce(nullif(event_slug,''),market_key) event_key,
 sum(gross) gross,sum(paired_gross) paired,
 count(*)::int markets
 from checked where reconciled
 group by 1
 ), ranked as(
 select *, row_number() over(order by gross desc) profit_rank,
 row_number() over(order by gross asc) loss_rank,
 count(*) over() total_events
 from event)
 select count(*)::int events,sum(markets)::int markets,
 avg(gross)::float8 mean_gross_per_event,
 stddev_samp(gross)::float8 sd_gross_per_event,
 (avg(gross)-1.96*stddev_samp(gross)/sqrt(count(*)::numeric))::float8
  approx_gross_event_mean_95_low,
 (avg(gross)+1.96*stddev_samp(gross)/sqrt(count(*)::numeric))::float8
  approx_gross_event_mean_95_high,
 avg(paired)::float8 mean_pair_per_event,
 (avg(paired)-1.96*stddev_samp(paired)/sqrt(count(*)::numeric))::float8
  approx_pair_event_mean_95_low,
 (avg(paired)+1.96*stddev_samp(paired)/sqrt(count(*)::numeric))::float8
  approx_pair_event_mean_95_high,
 count(*) filter(where gross>0)::int positive_events,
 count(*) filter(where paired>0)::int positive_pair_events,
 sum(gross) filter(where profit_rank<=ceil(total_events*0.01))::float8 top_1pct_gross,
 sum(gross) filter(where loss_rank<=ceil(total_events*0.01))::float8 bottom_1pct_gross,
 max(gross)::float8 best_event_gross,min(gross)::float8 worst_event_gross
 from ranked`);
 const oneSided=await db.unsafe(`
 with cash as materialized(
 select market_key,sum(reported_usdc_size) filter(where kind='REDEEM') redeemed,
 sum(reported_usdc_size) filter(where kind='MERGE') merged
 from pi.rn1_full_activity_metrics
 where kind in('REDEEM','MERGE') group by 1)
 select count(*)::int markets,
 count(*) filter(where coalesce(c.redeemed,0)>0)::int markets_with_redemption,
 count(*) filter(where coalesce(c.redeemed,0)=0)::int markets_without_redemption,
 count(*) filter(where coalesce(c.redeemed,0)>0 and
 abs(coalesce(c.redeemed,0)+coalesce(c.merged,0)-greatest(m.buy0_shares,m.buy1_shares))<=1)::int
 matching_redeemed,
 sum(m.buy0_cost+m.buy1_cost) filter(where coalesce(c.redeemed,0)=0)::float8
  cost_without_observed_redemption,
 sum(m.buy0_cost+m.buy1_cost) filter(where coalesce(c.redeemed,0)>0)::float8
  cost_with_redemption,
 sum(coalesce(c.redeemed,0)+coalesce(c.merged,0)) filter(where coalesce(c.redeemed,0)>0)::float8
  returned_with_redemption
 from pi.rn1_full_market_metrics m
 left join cash c using(market_key)
 where m.wallet=$1 and m.min_trade_at>='2026-09-21T00:00:00+00'
 and m.max_trade_at<'2026-11-12T00:00:00+00'
 and ((m.buy0_shares>0 and m.buy1_shares=0) or
 (m.buy1_shares>0 and m.buy0_shares=0))`,[RN1]);
 const total=summary[0]||{},weeks=weekly||[];
 return {
  scope:"conditional_reconciled_two_sided_gross_before_fees",
  fixed_first_trade_cutoff:"2026-09-21T00:00:00Z",
  fixed_last_trade_cutoff:"2026-11-12T00:00:00Z",
  summary:total,weekly:weeks,by_skew:skewImpact,official:official[0]||{},event_risk:eventRisk[0]||{},one_sided:oneSided[0]||{},
  caveats:[
   "Only 2-sided markets with REDEEM and a payout matching one observed outcome's share count within 1 USD are counted. Single-sided markets, unresolved positions and nonreconciled markets are excluded.",
   "Gross economic result excludes exchange fees, rebates, rewards, transfers and any buy/sell flow not present in the public sources.",
   "Paired contribution is an ex post VWAP-based algebraic decomposition. It does not establish that RN1 placed executable complementary orders simultaneously.",
   "No historical unexecuted limit-order book is available, so precise quote-setting thresholds and adverse-selection losses cannot be independently identified.",
   "Weekly results are grouped by latest observed trade and the week of November 9 is truncated by the fixed November 12 cutoff."
  ]
 };
}

// Independent native Polymarket cumulative wallet accounting. Observed PnL
// is not a causal estimate of a copy-trading strategy or a return on capital.
async function rn1OfficialVerdict(){
 const row=await db.unsafe(`
 with a as(
  select record,start_at from (
   select record,observed_at start_at from pi.rn1_official_pnl_points
   where wallet=$1 and observed_at<='2026-09-21 00:00:00+00'
   order by observed_at desc limit 1) x
 ), b as(
  select record,end_at from(
   select record,observed_at end_at from pi.rn1_official_pnl_points
   where wallet=$1 and observed_at<='2026-11-12 00:00:00+00'
   order by observed_at desc limit 1) y
 )
 select a.start_at::text start_at,b.end_at::text end_at,
 ((b.record->>'economic_pnl')::numeric-(a.record->>'economic_pnl')::numeric)::float8 economic_delta,
 ((b.record->>'realized_market_pnl')::numeric-(a.record->>'realized_market_pnl')::numeric)::float8 market_delta,
 ((b.record->>'unrealized_pnl')::numeric-(a.record->>'unrealized_pnl')::numeric)::float8 unrealized_delta,
 ((b.record->>'maker_rebate')::numeric-(a.record->>'maker_rebate')::numeric)::float8 maker_rebates,
 ((b.record->>'taker_rebate')::numeric-(a.record->>'taker_rebate')::numeric)::float8 taker_rebates,
 ((b.record->>'reward_income')::numeric-(a.record->>'reward_income')::numeric)::float8 reward_delta,
 ((b.record->>'fees_paid')::numeric-(a.record->>'fees_paid')::numeric)::float8 fees_paid_delta,
 ((b.record->>'volume_usdc')::numeric-(a.record->>'volume_usdc')::numeric)::float8 trading_turnover,
 (select count(*)::int from pi.rn1_official_pnl_points where wallet=$1) total_points,
 (select max(observed_at)::text from pi.rn1_official_pnl_points where wallet=$1) last_at
 from a cross join b`,[RN1]);
 const weekly=await db.unsafe(`
 with points as(
 select observed_at,(record->>'economic_pnl')::numeric economic,
 (record->>'realized_market_pnl')::numeric market,
 (record->>'volume_usdc')::numeric turnover
 from pi.rn1_official_pnl_points where wallet=$1
 ), w as(
 select generate_series('2026-09-21'::timestamptz,
  '2026-11-09'::timestamptz,'7 days') week
 ), boundaries as(
 select w.week,
 (select p.economic from points p where p.observed_at<=w.week order by observed_at desc limit 1) start_econ,
 (select p.economic from points p where p.observed_at<=least(w.week+interval '7 days','2026-11-12'::timestamptz) order by observed_at desc limit 1) end_econ,
 (select p.market from points p where p.observed_at<=w.week order by observed_at desc limit 1) start_market,
 (select p.market from points p where p.observed_at<=least(w.week+interval '7 days','2026-11-12'::timestamptz) order by observed_at desc limit 1) end_market,
 (select p.turnover from points p where p.observed_at<=w.week order by observed_at desc limit 1) start_turn,
 (select p.turnover from points p where p.observed_at<=least(w.week+interval '7 days','2026-11-12'::timestamptz) order by observed_at desc limit 1) end_turn
 from w)
 select week::date::text week,
 (end_econ-start_econ)::float8 economic_delta,
 (end_market-start_market)::float8 market_delta,
 (end_turn-start_turn)::float8 turnover
 from boundaries order by week`,[RN1]);
 const risk=await db.unsafe(`
 with p as(
 select observed_at,(record->>'economic_pnl')::numeric economic
 from pi.rn1_official_pnl_points where wallet=$1
 and observed_at between '2026-09-21 00:00+00'::timestamptz
  and '2026-11-12 00:00+00'::timestamptz
 ), ranked as(
 select observed_at,economic,
 economic-lag(economic) over(order by observed_at) daily_delta,
 max(economic) over(order by observed_at rows unbounded preceding) running_peak
 from p)
 select count(*)::int points,
 count(*) filter(where daily_delta>0)::int profitable_days,
 count(*) filter(where daily_delta<0)::int losing_days,
 min(daily_delta)::float8 worst_day,
 max(daily_delta)::float8 best_day,
 max(running_peak-economic)::float8 max_observed_drawdown
 from ranked`,[RN1]);
 return {
  source:"Polymarket Data API v2 user-pnl cumulative native atoms; not an on-chain audit",
  cohort_start:"2026-09-21T00:00:00Z",cohort_end:"2026-11-12T00:00:00Z",
  summary:row[0]||{},weekly,observed_risk:risk[0]||{},
  limitations:[
   "Official economic PnL reflects trading, incentives and mark-to-market; this is NOT return on deployed capital.",
   "Fee counters and rebates may already be included in aggregate PnL. Never sum all components to economic PnL.",
   "PnL period measures the whole wallet; the 2-sided redeem cohort is conditional and NOT the same universe.",
   "These are historical filled outcomes; a copy trader cannot assume identical Maker fills or maker rebates."
  ]};
}
// Dedicated RN1 market-selection and fill-setup atlas.
// Distinct frames are labelled: all materialized market fills versus frozen 756k
// raw-fill profiler; event timing is a separately selected Gamma enrichment.
async function rn1SetupPatterns(){
 const q={
 coverage:`select
  (select count(*)::int from pi.rn1_full_market_metrics) markets,
  (select count(distinct event_slug)::int from pi.rn1_full_market_metrics) events,
  (select sum(fills)::bigint from pi.rn1_full_market_metrics) materialized_fills,
  (select sum(buy0_cost+buy1_cost)::float8 from pi.rn1_full_market_metrics) nominal_buys,
  (select status from pi.rn1_pattern_jobs limit 1) profile_status,
  (select pages_done from pi.rn1_pattern_jobs limit 1) profile_pages,
  (select fills_done from pi.rn1_pattern_jobs limit 1) profiled_fills,
  (select count(*)::int from pi.rn1_pattern_market_entries) profiled_markets,
  (select count(*)::int from pi.rn1_event_schedule where status='ok') scheduled_events,
  (select count(*)::int from pi.rn1_event_schedule) selected_events`,
 sports:`select pi.rn1_sport_group(event_slug) sport,
 count(*)::int markets,count(distinct event_slug)::int events,
 sum(fills)::bigint fills,sum(buy0_cost+buy1_cost)::float8 buy_usdc
 from pi.rn1_full_market_metrics group by 1 order by fills desc`,
 kinds:`select pi.rn1_market_group(title) kind,
 count(*)::int markets,count(distinct event_slug)::int events,
 sum(fills)::bigint fills,sum(buy0_cost+buy1_cost)::float8 buy_usdc
 from pi.rn1_full_market_metrics group by 1 order by fills desc`,
 leagues:`select split_part(event_slug,'-',1) league,
 pi.rn1_sport_group(event_slug) sport,count(*)::int markets,
 count(distinct event_slug)::int events,
 sum(fills)::bigint fills,sum(buy0_cost+buy1_cost)::float8 buy_usdc
 from pi.rn1_full_market_metrics group by 1,2 order by fills desc limit 48`,
 sport_kind:`select pi.rn1_sport_group(event_slug) sport,
 pi.rn1_market_group(title) kind,
 count(*)::int markets,sum(fills)::bigint fills,
 sum(buy0_cost+buy1_cost)::float8 buy_usdc
 from pi.rn1_full_market_metrics group by 1,2 order by fills desc`,
 depth:`select case
 when fills=1 then '1'
 when fills between 2 and 4 then '2–4'
 when fills between 5 and 9 then '5–9'
 when fills between 10 and 24 then '10–24'
 when fills between 25 and 49 then '25–49'
 when fills between 50 and 99 then '50–99'
 else '100+' end bracket,count(*)::int markets,
 sum(fills)::bigint fills,sum(buy0_cost+buy1_cost)::float8 buy_usdc
 from pi.rn1_full_market_metrics group by 1 order by min(fills)`,
 market_open_hour:`select extract(hour from min_trade_at at time zone 'UTC')::int as utc_hour,
 count(*)::int markets,sum(fills)::bigint lifetime_fills
 from pi.rn1_full_market_metrics group by 1 order by 1`,
 frozen_bins:`select d.dimension,v.key,
 sum((v.value->>'fills')::bigint)::bigint fills,
 sum((v.value->>'usdc')::numeric)::float8 buy_usdc,
 sum((v.value->>'shares')::numeric)::float8 shares
 from pi.rn1_pattern_page_stats p
 cross join lateral (values
  ('price',p.summary->'price'),('notional',p.summary->'notional'),
  ('utc_hour',p.summary->'utc_hour'),('utc_weekday',p.summary->'utc_weekday'),
  ('market_type',p.summary->'market_type'),('side',p.summary->'side')) d(dimension,items)
 cross join lateral jsonb_each(d.items) v(key,value)
 group by 1,2 order by d.dimension, v.key`,
 price_by_sport:`select pi.rn1_sport_group(split_part(v.key,'|',1)) sport,
 split_part(v.key,'|',2) price_bin,
 sum((v.value->>'fills')::bigint)::bigint fills,
 sum((v.value->>'usdc')::numeric)::float8 buy_usdc
 from pi.rn1_pattern_page_stats p
 cross join lateral jsonb_each(p.summary->'league_price') v(key,value)
 group by 1,2 order by 1,2`,
 price_by_type:`select split_part(v.key,'|',1) kind,
 split_part(v.key,'|',2) price_bin,
 sum((v.value->>'fills')::bigint)::bigint fills,
 sum((v.value->>'usdc')::numeric)::float8 buy_usdc
 from pi.rn1_pattern_page_stats p
 cross join lateral jsonb_each(p.summary->'type_price') v(key,value)
 group by 1,2 order by 1,2`,
 entry_stats:`select count(*)::int markets,
 count(*) filter(where first0_at is not null and first1_at is not null)::int both_sides,
 count(*) filter(where first_side=0)::int first_outcome0,
 count(*) filter(where first_side=1)::int first_outcome1,
 percentile_cont(0.5) within group(order by first_price)::float8 median_first_price,
 percentile_cont(0.5) within group(order by first_price*first_qty)::float8 median_first_notional,
 percentile_cont(0.5) within group(order by
  extract(epoch from greatest(first0_at,first1_at)-least(first0_at,first1_at))/60)
  filter(where first0_at is not null and first1_at is not null)::float8
  median_minutes_until_both_sides
 from pi.rn1_pattern_market_entries`,
 first_price_bins:`select (least(19,floor(first_price*20)::int)*5)::int lower_pct,
 count(*)::int markets,
 sum(first_qty*first_price)::float8 first_fill_usdc
 from pi.rn1_pattern_market_entries group by 1 order by 1`,
 first_notional_bins:`select case when first_qty*first_price<5 then '<5'
 when first_qty*first_price<20 then '5–20'
 when first_qty*first_price<50 then '20–50'
 when first_qty*first_price<100 then '50–100'
 when first_qty*first_price<250 then '100–250'
 when first_qty*first_price<500 then '250–500'
 when first_qty*first_price<1000 then '500–1000'
 when first_qty*first_price<5000 then '1000–5000' else '5000+' end bracket,
 count(*)::int markets
 from pi.rn1_pattern_market_entries group by 1`,
 entry_by_sport:`select pi.rn1_sport_group(event_slug) sport,
 count(*)::int markets,
 count(*) filter(where first0_at is not null and first1_at is not null)::int both_sides,
 percentile_cont(0.5) within group(order by first_price)::float8 median_first_price,
 percentile_cont(0.5) within group(order by first_qty*first_price)::float8 median_first_usdc,
 percentile_cont(0.5) within group(order by
  extract(epoch from greatest(first0_at,first1_at)-least(first0_at,first1_at))/60)
  filter(where first0_at is not null and first1_at is not null)::float8 median_pair_lag_min
 from pi.rn1_pattern_market_entries group by 1 order by markets desc`,
 start_time_coverage:`select selection,status,count(*)::int events,
 sum(event_fills)::bigint events_fills
 from pi.rn1_event_schedule group by 1,2 order by 1,2`,
 event_timing:`with e as(
 select event_slug,min(first_at) first_fill_at,
 sum(fills)::bigint observed_fills
 from pi.rn1_pattern_market_entries
 where event_slug in(select event_slug from pi.rn1_event_schedule where status='ok')
 group by event_slug),
 sample as(select s.selection,pi.rn1_sport_group(s.event_slug) sport,
 e.observed_fills,extract(epoch from e.first_fill_at-s.start_at)/60 minutes
 from pi.rn1_event_schedule s join e using(event_slug)
 where s.status='ok' and s.start_at is not null),
 bins as(select *,
 case when minutes < -60 then 'Avant -60 min'
      when minutes < 0 then 'Avant -60 à 0 min'
      when minutes < 5 then '0–5 min'
      when minutes < 15 then '5–15 min'
      when minutes < 30 then '15–30 min'
      when minutes < 60 then '30–60 min'
      else '60+ min' end timing from sample)
 select selection,sport,timing,count(*)::int events,sum(observed_fills)::bigint observed_fills,
 percentile_cont(0.5) within group(order by minutes)::float8 median_min_from_start
 from bins group by 1,2,3 order by 1,2,3`,
 event_timing_summary:`with e as(
 select event_slug,min(first_at) first_fill_at,
 sum(fills)::bigint observed_fills
 from pi.rn1_pattern_market_entries
 where event_slug in(select event_slug from pi.rn1_event_schedule where status='ok')
 group by event_slug)
 select s.selection,count(*)::int events,
 sum(e.observed_fills)::bigint observed_fills,
 percentile_cont(0.5) within group(order by extract(epoch from e.first_fill_at-s.start_at)/60)::float8 median_minutes,
 count(*) filter(where e.first_fill_at<s.start_at)::int pregame,
 count(*) filter(where e.first_fill_at>=s.start_at and e.first_fill_at<s.start_at+interval '5 minutes')::int first_5m,
 count(*) filter(where e.first_fill_at>=s.start_at+interval '5 minutes' and e.first_fill_at<s.start_at+interval '30 minutes')::int next_25m,
 count(*) filter(where e.first_fill_at>=s.start_at+interval '30 minutes')::int after_30m
 from pi.rn1_event_schedule s join e using(event_slug) where s.status='ok'
 group by s.selection order by s.selection`,
 top_starts:`with e as(
 select event_slug,min(first_at) first_fill_at,sum(fills)::bigint observed_fills
 from pi.rn1_pattern_market_entries
 where event_slug in(select event_slug from pi.rn1_event_schedule where status='ok')
 group by event_slug)
 select s.event_slug,s.selection,s.start_at::text scheduled_at,e.first_fill_at::text first_fill_at,
 round((extract(epoch from e.first_fill_at-s.start_at)/60)::numeric,2)::float8 minutes_from_start,
 e.observed_fills
 from pi.rn1_event_schedule s join e using(event_slug) where s.status='ok'
 order by e.observed_fills desc limit 18`
 };
 const keys=Object.keys(q);
 const results=await Promise.all(keys.map(k=>db.unsafe((q as any)[k])));
 const out:any={};
 keys.forEach((k,i)=>out[k]=(k==="coverage"||k==="entry_stats")?(results[i][0]||{}):results[i]);
 out.disclaimers=[
 "Deux bases de dénominateurs : les agrégats de marchés évoluent avec la collecte live ; les histogrammes détaillés portent uniquement sur le lot figé de 756 000 fills et avancent par pages.",
 "Horaires : premiers FILLs observés, jamais heure de dépôt du limit order. startTime Gamma est le démarrage annoncé, non une preuve d'horodatage exact de chaque événement.",
 "L'échantillon de calendriers est construit volontairement en 600 événements très actifs ET 600 événements tirés séparément. Ne jamais confondre les distributions de ces groupes avec celle des 27 000+ événements.",
 "Les indices 0/1 désignent les issues du marché, qui peuvent être des équipes ; ce ne sont pas nécessairement YES et NO textuels.",
 "Cotes et tailles sont celles des transactions remplies, PAS celles des ordres annulés ou non remplis. Les rôles Maker/Taker sont globalement audités mais pas ventilés dans les nouvelles coupes de prix."
 ];
 return out;
}
async function rn1ReverseEngineering(){
 // Full public-source collection is distinct from the old 4k taker-only pilot.
 // All percentages below describe observed fills, not trader's alpha or true current inventory.
 const streams=await db.unsafe(`
 select stream,status,pages_fetched::double precision as pages_fetched,
 rows_seen::double precision as rows_seen,rows_valid::double precision as rows_valid,
 rows_invalid::double precision as rows_invalid,raw_gzip_bytes::double precision as raw_gzip_bytes,
 metrics_rows::double precision as metrics_rows,metrics_paused_at::text as metrics_paused_at,
 first_seen_at::text as oldest_observed_at,last_seen_at::text as newest_observed_at,
 last_success_at::text,last_error,
 max_raw_bytes::double precision as max_raw_bytes,max_db_bytes::double precision as max_db_bytes
 from pi.rn1_full_streams where wallet=$1 order by stream`,[RN1]);
 const market=await db.unsafe(`
 select count(*)::int as observed_markets,
 coalesce(sum(fills),0)::double precision as fills,
 coalesce(sum(buy_fills),0)::double precision as buy_fills,
 coalesce(sum(sell_fills),0)::double precision as sell_fills,
 count(*) filter(where buy0_shares>0 and buy1_shares>0)::int as markets_bought_both_sides,
 count(*) filter(where buy0_shares>0 and buy1_shares>0
   and greatest(buy0_shares,buy1_shares)>=2*least(buy0_shares,buy1_shares))::int as two_sided_skew_over_2x,
 count(*) filter(where buy0_shares>0 and buy1_shares>0
   and buy0_cost/nullif(buy0_shares,0)+buy1_cost/nullif(buy1_shares,0)<1)::int as two_sided_vwap_cost_below_one,
 count(*) filter(where buy0_shares>0 and buy1_shares>0
   and buy0_cost/nullif(buy0_shares,0)+buy1_cost/nullif(buy1_shares,0)>=1)::int as two_sided_vwap_cost_at_or_above_one,
 coalesce(sum(buy0_cost+buy1_cost),0)::double precision as buy_notional,
 coalesce(sum(sell0_proceeds+sell1_proceeds),0)::double precision as sell_notional,
 coalesce(sum(unknown_outcome_fills),0)::double precision as unlabeled_outcomes
 from pi.rn1_full_market_metrics where wallet=$1`,[RN1]);
 const activity=await db.unsafe(`
 select kind,sum(events)::double precision events,
 sum(reported_usdc_size)::double precision reported_usdc_size,
 sum(amount_present)::double precision events_with_reported_amount
 from pi.rn1_full_activity_metrics where wallet=$1
 group by kind order by sum(events) desc limit 20`,[RN1]);
 const role=await db.unsafe(`
 select count(*) filter(where role_status='verified')::int as verified_pages,
 count(*) filter(where role_status in('pending','error'))::int as pending_pages,
 count(*) filter(where role_status='partial')::int as incomplete_pages,
 coalesce(sum(maker_fills) filter(where role_status='verified'),0)::double precision as maker_fills,
 coalesce(sum(taker_fills) filter(where role_status='verified'),0)::double precision as taker_fills
 from pi.rn1_full_archive_pages where stream='trades_all'`);


 const sequenceJob=await db.unsafe(`
 select cohort_last_page::float8 as cohort_last_page,
 next_page::float8 as next_page,
 pages_done::float8 as pages_done,observed_fills::float8 as observed_fills,
 valid_fills::float8 as valid_fills,status,
 last_success_at::text as last_success_at,completed_at::text as completed_at,last_error
 from pi.rn1_sequence_jobs where job_key='rn1_executed_flow'`);
 const sequenceStats=await db.unsafe(`
 select coalesce(sample_half,'total') as sample_half,
 count(*)::int as pages,
 coalesce(sum((stats->>'fills')::int),0)::float8 as fills,
 coalesce(sum((stats->>'buy_fills')::int),0)::float8 as buys,
 coalesce(sum((stats->>'sell_fills')::int),0)::float8 as sells,
 coalesce(sum((stats->>'comparable_buy_fills')::int),0)::float8 as comparable_buys,
 coalesce(sum((stats->>'underweight_buys')::int),0)::float8 as underweight_buys,
 coalesce(sum((stats->>'overweight_buys')::int),0)::float8 as overweight_buys,
 coalesce(sum((stats->>'neutral_buys')::int),0)::float8 as neutral_buys,
 coalesce(sum((stats->>'reduces_gap_buys')::int),0)::float8 as gap_reducing_buys,
 coalesce(sum((stats->>'increases_gap_buys')::int),0)::float8 as gap_expanding_buys,
 coalesce(sum((stats->>'overcorrects_buys')::int),0)::float8 as overcorrecting_buys,
 coalesce(sum((stats->>'first_opposite_fills')::int),0)::float8 as first_opposite_fills,
 coalesce(sum((stats->>'repeat_same_outcome_300s')::int),0)::float8 as same_outcome_repeats_5min,
 coalesce(sum((stats->>'same_outcome_same_price_300s')::int),0)::float8 as repeated_price_unchanged,
 coalesce(sum((stats->>'same_outcome_price_up_300s')::int),0)::float8 as repeated_price_up,
 coalesce(sum((stats->>'same_outcome_price_down_300s')::int),0)::float8 as repeated_price_down,
 coalesce(sum((stats->'lag_buckets'->>0)::int),0)::float8 as opposite_lag_under_1min,
 coalesce(sum((stats->'lag_buckets'->>1)::int),0)::float8 as opposite_lag_1to5min,
 coalesce(sum((stats->'lag_buckets'->>2)::int),0)::float8 as opposite_lag_5to15min,
 coalesce(sum((stats->'lag_buckets'->>3)::int),0)::float8 as opposite_lag_15to60min,
 coalesce(sum((stats->'lag_buckets'->>4)::int),0)::float8 as opposite_lag_over_60min
 from pi.rn1_sequence_page_stats
 group by rollup(sample_half) order by sample_half`);


 const sequenceSkew=await db.unsafe(`
 with bins as(
  select sample_half, b.ord::int as skew_bin,
   (b.x->>'underweight')::bigint as underweight,
   (b.x->>'overweight')::bigint as overweight,
   (b.x->>'neutral')::bigint as neutral,
   (b.x->>'total')::bigint as fills
  from pi.rn1_sequence_page_stats
  cross join lateral jsonb_array_elements(stats->'imbalance_buckets')
   with ordinality as b(x,ord)
 )
 select coalesce(sample_half,'total') sample_half,skew_bin,
 sum(fills)::float8 fills,
 sum(underweight)::float8 underweight,
 sum(overweight)::float8 overweight,
 sum(neutral)::float8 neutral
 from bins group by rollup(sample_half),skew_bin
 order by sample_half,skew_bin`);

 const fullReplay=await db.unsafe(`
 select status,frozen_last_page::float8 as frozen_last_page,
 pages_done::float8 as pages_done,fills_done::float8 as fills_done,
 maker_fills::float8 as maker_fills,taker_fills::float8 as taker_fills,
 unknown_fills::float8 as unknown_fills,
 summary->'inventory'->'maker' as maker_inventory,
 summary->'pair'->'maker' as maker_pair,
 summary->'forward' as maker_forward_proxy,
 summary->'coverage' as proxy_missing_coverage,
 last_success_at::text as last_success_at,last_error
 from pi.rn1_replay_jobs where job_key='rn1_full_chronology_v1'
 `);

 const independentPrices=await db.unsafe(`
 select status,frozen_last_page::float8 as frozen_last_page,
 pages_done::float8 as pages_done,source_fills::float8 as source_fills,
 sampled_buy_fills::float8 as sampled_buy_fills,
 sampled_maker_fills::float8 as sampled_maker_fills,
 sampled_taker_fills::float8 as sampled_taker_fills,
 sampled_unknown_fills::float8 as sampled_unknown_fills,
 summary->'market_price' as market_price,
 summary->'coverage' as price_history_coverage,
 summary->'event_cluster_evidence' as event_cluster_evidence,
 summary->'event_paired_differences' as event_paired_differences,
 summary->'event_maker_taker_contrast' as event_maker_taker_contrast,
 last_success_at::text as last_success_at,last_error
 from pi.rn1_independent_price_jobs
 where job_key='rn1_independent_price_v1'
 `);
 const independentCoverage=await db.unsafe(`
 select count(*)::int pages,
 count(distinct date_trunc('week',p.min_trade_at))::int weeks,
 (select count(distinct e.event_slug)::int
  from pi.rn1_independent_price_pages epage
  cross join lateral jsonb_array_elements_text(epage.sample_event_slugs)
   as e(event_slug)) as events,
 sum(p.history_requests)::int requested_tokens,
 sum(p.history_success)::int histories_with_prices
 from pi.rn1_independent_price_pages p
 `);

 const independentAdjusted=await db.unsafe(`
 with pages as(
  select page_no,source_tokens::numeric / nullif(sampled_tokens,0) as weight,
   summary from pi.rn1_independent_price_pages
  where source_tokens is not null and sampled_tokens>0
 ), horizons as(
  select p.page_no,p.weight,v.key as horizon,
   v.value->'maker|all' as maker,
   v.value->'maker|underweight' as under_maker,
   v.value->'maker|overweight' as over_maker
  from pages p cross join lateral jsonb_each(p.summary->'market_price') v
 )
 select horizon,count(distinct page_no)::int covered_pages,
 sum((maker->>'n')::numeric)::int observed_fills,
 (sum((maker->>'weighted')::numeric)
  /nullif(sum((maker->>'shares')::numeric),0))::float8 raw_quantity_markout,
 (sum((maker->>'weighted')::numeric*weight)
  /nullif(sum((maker->>'shares')::numeric*weight),0))::float8 adjusted_quantity_markout,
 sum((under_maker->>'n')::numeric)::int under_fills,
 (sum((under_maker->>'weighted')::numeric*weight)
  /nullif(sum((under_maker->>'shares')::numeric*weight),0))::float8
   adjusted_under_markout,
 sum((over_maker->>'n')::numeric)::int over_fills,
 (sum((over_maker->>'weighted')::numeric*weight)
  /nullif(sum((over_maker->>'shares')::numeric*weight),0))::float8
   adjusted_over_markout
 from horizons group by horizon order by horizon::int
 `);

 const independentWeekly=await db.unsafe(`
 select date_trunc('week',min_trade_at)::date::text as week,
 count(*)::int pages,
 sum(sampled_buy_fills)::int sampled_buy_fills,
 sum((summary->'market_price'->'900'->'maker|all'->>'n')::numeric)::int
  maker_reference_fills,
 (sum((summary->'market_price'->'900'->'maker|all'->>'weighted')::numeric)
  /nullif(sum((summary->'market_price'->'900'->'maker|all'->>'shares')::numeric),0))::float8
  maker_weighted_markout,
 sum((summary->'market_price'->'900'->'maker|underweight'->>'n')::numeric)::int
  maker_underweight_fills,
 (sum((summary->'market_price'->'900'->'maker|underweight'->>'weighted')::numeric)
  /nullif(sum((summary->'market_price'->'900'->'maker|underweight'->>'shares')::numeric),0))::float8
  maker_underweight_markout,
 sum((summary->'market_price'->'900'->'maker|overweight'->>'n')::numeric)::int
  maker_overweight_fills,
 (sum((summary->'market_price'->'900'->'maker|overweight'->>'weighted')::numeric)
  /nullif(sum((summary->'market_price'->'900'->'maker|overweight'->>'shares')::numeric),0))::float8
  maker_overweight_markout,
 (sum((summary->'market_price'->'900'->'maker|all'->>'weighted')::numeric*source_tokens/nullif(sampled_tokens,0))
  /nullif(sum((summary->'market_price'->'900'->'maker|all'->>'shares')::numeric*source_tokens/nullif(sampled_tokens,0)),0))::float8
  maker_adjusted_markout,
 (sum((summary->'market_price'->'900'->'maker|underweight'->>'weighted')::numeric*source_tokens/nullif(sampled_tokens,0))
  /nullif(sum((summary->'market_price'->'900'->'maker|underweight'->>'shares')::numeric*source_tokens/nullif(sampled_tokens,0)),0))::float8
  maker_under_adjusted,
 (sum((summary->'market_price'->'900'->'maker|overweight'->>'weighted')::numeric*source_tokens/nullif(sampled_tokens,0))
  /nullif(sum((summary->'market_price'->'900'->'maker|overweight'->>'shares')::numeric*source_tokens/nullif(sampled_tokens,0)),0))::float8
  maker_over_adjusted,
 sum((summary->'market_price'->'900'->'taker|all'->>'n')::numeric)::int taker_reference_fills,
 (sum((summary->'market_price'->'900'->'taker|all'->>'weighted')::numeric*source_tokens/nullif(sampled_tokens,0))
 / nullif(sum((summary->'market_price'->'900'->'taker|all'->>'shares')::numeric*source_tokens/nullif(sampled_tokens,0)),0))::float8 taker_adjusted_markout,
 sum((summary->'market_price'->'900'->'maker|all'->>'weighted')::numeric*source_tokens/nullif(sampled_tokens,0))::float8 maker_adjusted_numerator,
 sum((summary->'market_price'->'900'->'maker|all'->>'shares')::numeric*source_tokens/nullif(sampled_tokens,0))::float8 maker_adjusted_denominator
 from pi.rn1_independent_price_pages where source_tokens is not null
 group by 1 order by 1
 `);

 const independentLeaveOneWeekOut=await db.unsafe(`
 with weekly as(
 select date_trunc('week',min_trade_at)::date::text week,
 count(*)::int pages,
 sum((summary->'market_price'->'900'->'maker|all'->>'n')::numeric)::bigint maker_fills,
 sum((summary->'market_price'->'900'->'maker|all'->>'weighted')::numeric*source_tokens/nullif(sampled_tokens,0)) move_sum,
 sum((summary->'market_price'->'900'->'maker|all'->>'shares')::numeric*source_tokens/nullif(sampled_tokens,0)) shares_sum
 from pi.rn1_independent_price_pages
 where source_tokens>0 and sampled_tokens>0
 group by 1)
 select excluded.week excluded_week,
 coalesce(sum(w.pages),0)::int other_pages,
 coalesce(sum(w.maker_fills),0)::bigint other_maker_fills,
 (sum(w.move_sum)/nullif(sum(w.shares_sum),0))::float8 other_maker_adjusted_markout
 from weekly excluded left join weekly w on w.week<>excluded.week
 group by excluded.week order by excluded.week
 `);
 const bytes=await db.unsafe(`
 select pg_database_size(current_database())::double precision as project_database_bytes,
 (select coalesce(sum(raw_gzip_bytes),0)::double precision from pi.rn1_full_streams) as private_archive_bytes`);
 const economics=await rn1EconomicAttribution();
 const official_verdict=await rn1OfficialVerdict();
 const completed=streams.length===2&&streams.every((s:any)=>s.status==="source_exhausted");
 return {status:completed?"source_exhausted_verified":"collection_in_progress",
  data_scope:"V2 public wallet trades: start=1, taker_only=false, 1,000 rows/page; activity: start=1, 1,000 rows/page",
  streams,market:market[0]||{},activity,economics,official_verdict,role_audit:role[0]||{},full_replay:fullReplay[0]||null,independent_price:independentPrices[0]||null,independent_coverage:independentCoverage[0]||{},independent_weekly:independentWeekly,independent_leave_one_week_out:independentLeaveOneWeekOut,independent_adjusted:independentAdjusted,sequence:{job:sequenceJob[0]||null,stats:sequenceStats,skew:sequenceSkew},storage:bytes[0]||{},
  inference:[
   {name:"Part des achats effectués sur les deux issues",verification:"observed"},
   {name:"Déséquilibre des quantités entre issues",verification:"observed"},
   {name:"Règles exactes de prix, ordre maker/taker et annulations",verification:"not_identifiable_from_feed_only"},
   {name:"Rentabilité nette et contribution des rebates",verification:"requires_full_inventory_and_cashflow_reconciliation"}
  ],
  limits:"Full source archiving continues after the shared SQL analysis budget is reached; market aggregates may become partial. Archiving pauses only at the private Storage safety budget. Completion is only verified when BOTH feeds return has_more=false. The Data API does not expose unfilled orders or hidden private models.",
  legacy_notice:"Previous 4,000-trade analyses were based on Polymarket's default taker-only feed. Their strategic conclusions were preliminary and should not be treated as full-wallet findings."};
}

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


// Observed price-momentum / RN1 fill associations; no order-placement or causal inference.
async function rn1TriggerWindows(body:any){
 const runLimit=Math.round(number(body.runs,600,100,1500));
 const sql="\nwith recent_runs as (\n  select id,received_at,quotes\n  from pi.rn1_quote_probe_runs\n  order by id desc limit $1\n), snapshots as (\n select r.id run_id,(e->>'asset_id') token_id,(e->>'market_key') market_key,\n        (e->>'origin') origin,(e->>'mid')::numeric mid,\n        (e->>'spread')::numeric spread,\n        to_timestamp((e->>'book_at')::numeric/1000) book_at,r.received_at\n from recent_runs r cross join lateral jsonb_array_elements(r.quotes) e\n where (e->>'book_valid')::boolean=true\n), fresh as (\n select * from snapshots\n where received_at>=book_at and received_at-book_at<=interval '15 seconds'\n   and spread between 0 and 0.10 and mid between 0.01 and 0.99\n), previous as (\n select *,lag(mid) over(partition by token_id order by book_at,run_id) prev_mid,\n          lag(book_at) over(partition by token_id order by book_at,run_id) prev_at\n from fresh\n), slots as (\n select *,\n   case when mid-prev_mid>=0.03 then 'big_up'\n        when mid-prev_mid>=0.01 then 'up_1_3c'\n        when mid-prev_mid<=-0.03 then 'big_down'\n        when mid-prev_mid<=-0.01 then 'down_1_3c'\n        else 'stable' end price_move\n from previous\n where prev_mid is not null\n   and book_at-prev_at between interval '10 seconds' and interval '3 minutes'\n), fills as (\n select run_id,token_id,\n        count(*) filter(where lag_seconds>=0 and lag_seconds<60) n,\n        count(*) filter(where lag_seconds>=0 and lag_seconds<60\n                        and role='maker_inferred') maker,\n        count(*) filter(where lag_seconds>=0 and lag_seconds<60\n                        and role='taker_verified') taker\n from pi.rn1_quote_probe_fills group by run_id,token_id\n)\nselect s.origin,s.price_move,count(*)::int samples,\n       count(distinct s.token_id)::int tokens,\n       count(distinct s.market_key)::int markets,\n       count(*) filter(where coalesce(f.n,0)>0)::int filled_slots,\n       coalesce(sum(f.n),0)::int fills,\n       coalesce(sum(f.maker),0)::int maker_fills,\n       coalesce(sum(f.taker),0)::int taker_fills,\n       round(100.0*count(*) filter(where coalesce(f.n,0)>0)/count(*),2)::float8 as fill_rate_pct\nfrom slots s left join fills f on f.run_id=s.run_id and f.token_id=s.token_id\ngroup by s.origin,s.price_move order by s.origin,s.price_move";
 const rows=await db.unsafe(sql,[runLimit]);
 const state=await db.unsafe("select status,completed_runs::int as completed_runs,matched_fills::int as matched_fills,last_success_at::text as last_success_at from pi.rn1_quote_probe_state limit 1");
 return {rows,coverage:{...state[0],max_runs_requested:runLimit},window_seconds:60,
  warnings:["Fenêtres token-minute conditionnelles aux marchés observés, pas des trades indépendants.","L'échantillon rn1_recent est sélectionné en fonction des fills récents ; sports_control n'est pas un groupe témoin apparié.","maker_inferred n'est pas un registre d'ordres privés ; l'heure du dépôt Maker est inconnue.","Filtre : carnet valide, âge <=15 s, spread <=10 cents, mid entre 1% et 99%, historique précédent de 10 à 180 s ; pas de contrôle des événements de jeu."]};
}


async function rn1SportsImpact(body:any){
 const windowSeconds=[30,60].includes(Number(body?.window_seconds))?Number(body.window_seconds):30;
 const slug=/^nba-[a-z]{2,4}-[a-z]{2,4}-20\d\d-\d\d-\d\d$/.test(String(body?.event_slug||""))
  ?String(body.event_slug):"";
 const statement=`
 with games as (
  select e.event_slug,e.first_play_at,e.last_play_at
  from pi.rn1_nba_espn_links e
  where e.status='complete'
    and exists(select 1 from pi.trades t where t.event_slug=e.event_slug)
 ), ranked as (
  select p.event_slug,p.play_at,p.sequence_number,p.period_number,
    p.is_scoring,p.home_score,p.away_score,
    row_number() over(partition by p.event_slug order by p.play_at,p.sequence_number,p.play_id) rn,
    row_number() over(partition by p.event_slug,p.period_number order by p.play_at,p.sequence_number,p.play_id) quarter_rank
  from pi.rn1_nba_espn_plays p join games g on p.event_slug=g.event_slug
 ), last_known as (
  select r.*,
   max(rn) filter(where home_score is not null and away_score is not null and home_score<>away_score)
    over(partition by event_slug order by rn rows between unbounded preceding and 1 preceding) prior_leader_rn
  from ranked r
 ), events as (
  select a.event_slug,a.play_at,a.is_scoring,(a.quarter_rank=1) period_start,
   (a.home_score<>a.away_score and b.home_score is not null and b.away_score is not null
    and sign(a.home_score-a.away_score)<>sign(b.home_score-b.away_score)) lead_change
  from last_known a left join ranked b on b.event_slug=a.event_slug and b.rn=a.prior_leader_rn
 ), buckets as (
  select e.event_slug,floor(extract(epoch from(e.play_at-g.first_play_at))/${windowSeconds})::int bin,
   bool_or(e.is_scoring) score,bool_or(e.period_start) quarter,
   bool_or(e.lead_change) lead
  from events e join games g on e.event_slug=g.event_slug group by 1,2
 ), fills as (
  select t.event_slug,floor(extract(epoch from(t.reported_at-g.first_play_at)) /${windowSeconds})::int bin,
   count(*) fills
  from pi.trades t join games g on t.event_slug=g.event_slug
  where t.reported_at between g.first_play_at and g.last_play_at+interval '1 minute'
  group by 1,2
 ), classified as (
  select b.event_slug,v.kind,v.exposed,coalesce(f.fills,0) next_fills
  from buckets b
  cross join lateral (values('score',b.score),('lead',b.lead),('quarter',b.quarter)) v(kind,exposed)
  left join fills f on f.event_slug=b.event_slug and f.bin=b.bin+1
  where v.kind<>'lead' or b.score
 )
 select event_slug,kind,exposed,
  count(*)::int windows,count(*) filter(where next_fills>0)::int filled_windows,
  sum(next_fills)::int following_fills
 from classified group by 1,2,3 order by event_slug,kind,exposed desc
 `;
 const rows=await db.unsafe(statement);
 const games=await db.unsafe(`
 select l.event_slug,l.game_day::text game_day,l.espn_event_id,l.status,
  l.plays_timed,l.scoring_plays,l.first_play_at::text first_play_at,
  l.last_play_at::text last_play_at,
  (select count(*)::int from pi.trades t where t.event_slug=l.event_slug) observed_fills
 from pi.rn1_nba_espn_links l
 where l.status in ('complete','partial')
 order by l.game_day desc,l.event_slug limit 75
 `);
 const coverage=await db.unsafe(`
 select count(*)::int total,
 count(*) filter(where status='complete')::int complete,
 count(*) filter(where status='partial')::int partial,
 count(*) filter(where status='missing')::int missing,
 coalesce(sum(plays_timed),0)::int timed_plays,
 coalesce(sum(scoring_plays),0)::int scoring_plays,
 (select count(*)::int from pi.trades) pilot_trades
 from pi.rn1_nba_espn_links`);
 const totals:any[]=[];
 for(const kind of ["score","lead","quarter"]){
  for(const exposed of [true,false]){
   const select=rows.filter((r:any)=>r.kind===kind&&r.exposed===exposed);
   const sum=(k:string)=>select.reduce((s:number,r:any)=>s+Number(r[k]||0),0);
   const windows=sum("windows"),filledWindows=sum("filled_windows");
   totals.push({kind,exposed,windows,filled_windows:filledWindows,following_fills:sum("following_fills"),
    fill_window_pct:windows?100*filledWindows/windows:null,distinct_games:select.length});
  }
 }
 let timeline:any[]=[], token:null|string=null, priceTimeline:any[]=[];
 if(slug && games.some((g:any)=>g.event_slug===slug)){
  timeline=await db.unsafe(`
   with g as(select event_slug,first_play_at,last_play_at
     from pi.rn1_nba_espn_links where event_slug=$1),
   bins as(select x.i from g cross join lateral
     generate_series(0,least(85,floor(extract(epoch from(g.last_play_at-g.first_play_at))/120)::int)) x(i)),
   pp as(select floor(extract(epoch from(p.play_at-g.first_play_at))/120)::int i,
     count(*)::int plays,count(*) filter(where p.is_scoring)::int scoring,
     count(distinct p.period_number)::int periods,
     max(p.home_score)::int max_home_score,max(p.away_score)::int max_away_score
     from pi.rn1_nba_espn_plays p join g on p.event_slug=g.event_slug group by 1),
   tt as(select floor(extract(epoch from(t.reported_at-g.first_play_at))/120)::int i,
     count(*)::int fills,sum(t.observed_notional_usdc)::float8 notional
     from pi.trades t join g on t.event_slug=g.event_slug group by 1)
   select b.i,coalesce(pp.plays,0) plays,coalesce(pp.scoring,0) scoring,
     coalesce(tt.fills,0) fills,coalesce(tt.notional,0) notional
   from bins b left join pp on pp.i=b.i left join tt on tt.i=b.i order by b.i
  `,[slug]);
  const tok=await db.unsafe(`
   select b.token_id,count(*)::int fills
   from pi.rn1_fill_price_benchmark b
   join pi.rn1_pattern_market_entries e on e.market_key=b.market_key
   where e.event_slug=$1 group by b.token_id order by count(*) desc limit 1
  `,[slug]);
  token=tok[0]?.token_id??null;
  if(token){
   const e=games.find((g:any)=>g.event_slug===slug);
   const start=Math.floor(Date.parse(e.first_play_at)/1000);
   const end=Math.floor(Date.parse(e.last_play_at)/1000);
   priceTimeline=await db.unsafe(`
    select floor((observed_epoch-$2::bigint)/120)::int i,
     avg(price)::float8 mean_price,count(*)::int points
    from pi.rn1_historical_price_points
    where token_id=$1 and observed_epoch between $2::bigint and $3::bigint
    group by 1 order by 1 limit 100
   `,[token,start,end]);
  }
 }
 const liveRoles=await db.unsafe(`
 with matched as (
  select distinct on(f.fingerprint) f.fingerprint,f.trade_at,f.role,
   q->>'event_slug' event_slug
  from pi.rn1_quote_probe_fills f
  join pi.rn1_quote_probe_runs r on r.id=f.run_id
  cross join lateral jsonb_array_elements(r.quotes) q
  where q->>'asset_id'=f.token_id and q->>'event_slug' like 'nba-%'
  order by f.fingerprint
 )
 select f.event_slug,f.role,count(*)::int fills,
  count(*) filter(where exists(
   select 1 from pi.rn1_nba_espn_plays p
   where p.event_slug=f.event_slug and p.is_scoring
    and p.play_at between f.trade_at-interval '30 seconds' and f.trade_at
  ))::int with_score_last30,
  count(*) filter(where exists(
   select 1 from pi.rn1_nba_espn_plays p
   where p.event_slug=f.event_slug and p.is_scoring
    and p.play_at between f.trade_at-interval '60 seconds' and f.trade_at
  ))::int with_score_last60
 from matched f group by 1,2 order by 1,2
 `);

 const priceVsEvents=await db.unsafe(`
 with mapping as (
  select distinct b.token_id,e.event_slug
  from pi.rn1_fill_price_benchmark b
  join pi.rn1_pattern_market_entries e on e.market_key=b.market_key
  join pi.rn1_nba_espn_links l on l.event_slug=e.event_slug and l.status='complete'
 ), prices as (
  select h.token_id,h.observed_epoch,h.price,
   lag(h.observed_epoch) over(partition by h.token_id order by h.observed_epoch) prev_epoch,
   lag(h.price) over(partition by h.token_id order by h.observed_epoch) prev_price
  from pi.rn1_historical_price_points h where h.resolution_seconds=60
 ), observed as (
  select m.event_slug,pr.*,(pr.price-pr.prev_price) delta
  from mapping m join prices pr on pr.token_id=m.token_id
  join pi.rn1_nba_espn_links l on l.event_slug=m.event_slug
  where pr.prev_price is not null and pr.observed_epoch-pr.prev_epoch between 60 and 180
   and to_timestamp(pr.observed_epoch) between l.first_play_at and l.last_play_at
 ), events as (
  select x.*,
   exists(select 1 from pi.rn1_nba_espn_plays p where p.event_slug=x.event_slug
    and p.play_at>to_timestamp(x.prev_epoch) and p.play_at<=to_timestamp(x.observed_epoch)) has_play,
   exists(select 1 from pi.rn1_nba_espn_plays p where p.event_slug=x.event_slug
    and p.is_scoring and p.play_at>to_timestamp(x.prev_epoch)
    and p.play_at<=to_timestamp(x.observed_epoch)) has_score,
   exists(select 1 from pi.trades t where t.token_id=x.token_id
    and t.reported_at>to_timestamp(x.observed_epoch)
    and t.reported_at<=to_timestamp(x.observed_epoch)+interval '60 seconds') next_fill
  from observed x
 )
 select has_score,
  case when abs(delta)>=0.03 then '>=3c'
       when abs(delta)>=0.01 then '1-3c' else '<1c' end move,
  count(*)::int intervals,count(distinct token_id)::int tokens,
  count(distinct event_slug)::int games,
  count(*) filter(where next_fill)::int next_fill_windows,
  round(100.0*count(*) filter(where next_fill)/count(*),2)::float8 next_fill_pct,
  round(avg(abs(delta)),5)::float8 mean_abs_change
 from events where has_play group by 1,2 order by has_score desc,move
 `);
 return {coverage:coverage[0]??{},games,totals,per_game:rows,live_roles:liveRoles,price_vs_events:priceVsEvents,
   selection:slug||null,window_seconds:windowSeconds,timeline,price_timeline:priceTimeline,
   price_token:token,
   caveats:[
    "Analyse du pilote historique de 4 000 exécutions Taker-only (filtre taker_only omis dans /v2/trades). Ce n'est PAS un échantillon représentatif des 756 000 exécutions, dont 89,2 % sont Maker.",
    "Unité statistique : fenêtre avec jeu observé ; label événement dans cette fenêtre, fill dans la fenêtre chronologique suivante. Ce n'est pas un ordre Maker nouvellement placé.",
    "Les périodes de jeu et l'activité de marché sont des variables confondantes : les fenêtres ne sont ni indépendantes ni appariées en liquidité.",
    "Changement de leader = passage du score non nul d'une équipe devant l'autre ; les égalités intermédiaires sont ignorées.",
    "Les 4 000 exécutions proviennent d'un feed Taker-only implicite ; leur rôle individuel n'a pas été réaudité par la méthode Maker/Taker du lot 756k. Les sondes live vérifient des rôles sur un échantillon distinct.",
    "Prix graphiques : dernière-trade historique à la minute d'un token choisi, pas meilleur bid/ask ni prix de décision de RN1.",
    "Résultat descriptif, pas prédiction causale, simulation d'exécution ou recommandation de copie."
   ]};
}


// Explicit on-demand sensitivity test; no prediction/backtest, no private Maker order times.
async function rn1SportsRobustness(){
 const rows=await db.unsafe("\nwith map as(\n select distinct b.token_id,e.event_slug,l.first_play_at,l.last_play_at\n from pi.rn1_fill_price_benchmark b\n join pi.rn1_pattern_market_entries e on e.market_key=b.market_key\n join pi.rn1_nba_espn_links l on e.event_slug=l.event_slug and l.status='complete'\n), prices as(\n select h.token_id,h.observed_epoch,h.price,\n lag(h.observed_epoch) over(partition by h.token_id order by h.observed_epoch) prev_epoch,\n lag(h.price) over(partition by h.token_id order by h.observed_epoch) prev_price\n from pi.rn1_historical_price_points h where h.resolution_seconds=60\n), observed as (\n select m.event_slug,m.first_play_at,p.token_id,p.observed_epoch,p.prev_epoch,\n p.price-p.prev_price delta,\n exists(select 1 from pi.rn1_nba_espn_plays a where a.event_slug=m.event_slug\n  and a.play_at>to_timestamp(p.prev_epoch) and a.play_at<=to_timestamp(p.observed_epoch)) has_play,\n exists(select 1 from pi.rn1_nba_espn_plays a where a.event_slug=m.event_slug and a.is_scoring\n  and a.play_at>to_timestamp(p.prev_epoch) and a.play_at<=to_timestamp(p.observed_epoch)) scored,\n exists(select 1 from pi.trades t where t.token_id=p.token_id\n  and t.reported_at>to_timestamp(p.observed_epoch)\n  and t.reported_at<=to_timestamp(p.observed_epoch)+interval '30 seconds') fill30,\n exists(select 1 from pi.trades t where t.token_id=p.token_id\n  and t.reported_at>to_timestamp(p.observed_epoch)\n  and t.reported_at<=to_timestamp(p.observed_epoch)+interval '60 seconds') fill60\n from map m join prices p on p.token_id=m.token_id\n where p.prev_price is not null and p.observed_epoch-p.prev_epoch between 60 and 180\n and to_timestamp(p.observed_epoch) between m.first_play_at and m.last_play_at\n), categories as(\n select o.*,v.seconds as phase_seconds,\n floor((observed_epoch-extract(epoch from first_play_at))/v.seconds)::int phase,\n case when abs(delta)<0.01 then 'stable' when abs(delta)<0.03 then 'medium' else 'large' end magnitude,\n case when delta>=0.01 then 'up' when delta<=-0.01 then 'down' else 'flat' end direction\n from observed o cross join (values(900),(1800),(3600)) v(seconds) where o.has_play\n), strata as (\n select event_slug,token_id,phase_seconds,phase,magnitude,direction,\n count(*) filter(where scored) ns,count(*) filter(where not scored) nn,\n count(*) filter(where scored and fill30) fs30,count(*) filter(where not scored and fill30) fn30,\n count(*) filter(where scored and fill60) fs60,count(*) filter(where not scored and fill60) fn60\n from categories group by 1,2,3,4,5,6\n), eligible as(select * from strata where ns>=2 and nn>=2)\nselect phase_seconds,event_slug,count(*)::int strata,\n sum(ns)::int scored_windows,sum(nn)::int control_windows,\n sum(fs30)::int scored_hits30,sum(fn30)::int control_hits30,\n sum(fs60)::int scored_hits60,sum(fn60)::int control_hits60,\n avg(100.0*fs30/ns-100.0*fn30/nn)::float8 avg_stratum_diff30,\n avg(100.0*fs60/ns-100.0*fn60/nn)::float8 avg_stratum_diff60\nfrom eligible group by 1,2 order by phase_seconds,event_slug");
 const phaseSummaries=[900,1800,3600].map(seconds=>{
  const r=rows.filter((x:any)=>Number(x.phase_seconds)===seconds);
  const total=(k:string)=>r.reduce((acc:number,x:any)=>acc+Number(x[k]??0),0);
  const games=r.length,ns=total("scored_windows"),nn=total("control_windows");
  const diffFor=(x:any,k:number)=>100*Number(x["scored_hits"+k])/Math.max(1,Number(x.scored_windows))-
      100*Number(x["control_hits"+k])/Math.max(1,Number(x.control_windows));
  const mean=(items:number[])=>items.length?items.reduce((a,b)=>a+b,0)/items.length:null;
  const d30=r.map((x:any)=>diffFor(x,30)),d60=r.map((x:any)=>diffFor(x,60));
  const weightedStratum=(k:string)=>total("strata")?
    r.reduce((acc:number,x:any)=>acc+Number(x.strata)*Number(x[k]??0),0)/total("strata"):null;
  return {phase_seconds:seconds,comparison_games:games,strata:total("strata"),
    scored_windows:ns,control_windows:nn,
    scored_hits30:total("scored_hits30"),control_hits30:total("control_hits30"),
    scored_hits60:total("scored_hits60"),control_hits60:total("control_hits60"),
    scored_rate30_pct:ns?100*total("scored_hits30")/ns:null,
    control_rate30_pct:nn?100*total("control_hits30")/nn:null,
    scored_rate60_pct:ns?100*total("scored_hits60")/ns:null,
    control_rate60_pct:nn?100*total("control_hits60")/nn:null,
    equal_stratum_diff30_pp:weightedStratum("avg_stratum_diff30"),
    equal_stratum_diff60_pp:weightedStratum("avg_stratum_diff60"),
    equal_game_diff30_pp:mean(d30),equal_game_diff60_pp:mean(d60),
    games_positive60:d60.filter(v=>v>0).length,games_negative60:d60.filter(v=>v<0).length,
    games_equal60:d60.filter(v=>v===0).length
  };
 });
 return {phase_summaries:phaseSummaries,
  games:rows.filter((x:any)=>Number(x.phase_seconds)===1800).map((x:any)=>({
    event_slug:x.event_slug,strata:x.strata,scored_windows:x.scored_windows,
    control_windows:x.control_windows,
    scored_hits60:x.scored_hits60,control_hits60:x.control_hits60,
    game_diff60_pp:100*Number(x.scored_hits60)/Math.max(1,Number(x.scored_windows))-
     100*Number(x.control_hits60)/Math.max(1,Number(x.control_windows))
  })),
  definitions:{
   source:"Historical minute trade-price points selected around the legacy 4,000-trade taker-only pilot (taker_only omitted); ESPN wallclock plays. NOT representative of Maker execution.",
   matching:"Same token, 15/30/60-minute elapsed-game interval, same magnitude <1c / 1–3c / >=3c and movement direction; >=2 windows for scoring and non-scoring within each stratum",
   event:"At least one ESPN scoring play between two prior price observation timestamps",
   outcome:"At least one RN1 fill strictly after second price timestamp, within 30 or 60 seconds",
   constraints:["Price point selection was conditioned on past RN1 activity; sample is not a random universe.",
   "Conditioning on price may block the causal pathway of a scoring play, and may induce selection bias.",
   "Repeated token-minutes, overlapping game events, and fills are not independent observations.",
   "The legacy 4,000-trade sample used the implicit Taker-only API filter; it is nonrepresentative of 756,000 full-wallet executions (89.2% Maker). No per-row role re-audit was done.",
   "Negative adjusted association is neither proof of absence of a sporting-event effect nor a valid profitable contrarian signal.",
   "This test is read-only. Historical book depth, private orders, unfilled orders, and actual order-submission timestamps remain unknown."]
  }};
}


async function rn1SizingForensics(){
 const hist=await db.unsafe("\nwith universe as (\n select sum((summary->'total'->>'fills')::bigint)::bigint fills,\n sum((summary->'total'->>'usdc')::numeric)::numeric total_usdc,\n sum((summary->'total'->>'buys')::bigint)::bigint buys,\n sum((summary->'total'->>'sells')::bigint)::bigint sells\n from pi.rn1_pattern_page_stats\n)\nselect h.key bucket,sum((h.value->>'fills')::bigint)::bigint fills,\n sum((h.value->>'usdc')::numeric)::numeric notional_usdc,\n (100.0*sum((h.value->>'fills')::numeric)/nullif(max(u.fills),0))::float8 fills_pct,\n (100.0*sum((h.value->>'usdc')::numeric)/nullif(max(u.total_usdc),0))::float8 volume_pct,\n max(u.fills)::bigint archive_fills,max(u.total_usdc)::numeric archive_total_usdc,\n max(u.buys)::bigint archive_buys,max(u.sells)::bigint archive_sells\nfrom pi.rn1_pattern_page_stats p\ncross join lateral jsonb_each(p.summary->'notional') h\ncross join universe u\ngroup by h.key\norder by case h.key\n when '<5' then 1 when '5–20' then 2 when '20–50' then 3\n when '50–100' then 4 when '100–250' then 5\n when '250–500' then 6 when '500–1000' then 7\n when '1000–5000' then 8 when '5000+' then 9 else 99 end");
 const roles=await db.unsafe("with inventory as(\n select r.id run_id,p->>'market_key' market_key,p->>'token_id' token_id,\n (p->>'current_size')::numeric holdings,\n (p->>'entry_cost_usdc')::numeric cost\n from pi.rn1_quote_probe_runs r\n cross join lateral jsonb_array_elements(r.positions) p\n where r.position_status='complete'\n  and r.position_observed_at is not null and r.position_observed_at<=r.received_at\n), snapshot as (\n select f.fingerprint,f.role,f.market_key,f.token_id,\n  f.fill_price,f.shares,f.fill_price*f.shares notional,\n  coalesce(sum(i.holdings) filter(where i.token_id=f.token_id),0) own,\n  coalesce(sum(i.holdings) filter(where i.token_id<>f.token_id),0) opposite,\n  coalesce(sum(i.cost),0) market_cost,\n  count(i.token_id) observed_outcomes\n from pi.rn1_quote_probe_fills f\n join pi.rn1_quote_probe_runs r on r.id=f.run_id\n left join inventory i on i.run_id=f.run_id and i.market_key=f.market_key\n where r.position_status='complete' and r.position_observed_at is not null\n and r.position_observed_at<=r.received_at and r.received_at<f.trade_at\n group by f.fingerprint,f.role,f.market_key,f.token_id,f.fill_price,f.shares\n), s as (\n select *,case when own<opposite then 'underweight'\n when own>opposite then 'overweight' else 'equal' end inventory_state,\n case when fill_price<0.20 then '<20%' when fill_price<0.40 then '20–40%'\n when fill_price<0.60 then '40–60%' when fill_price<0.80 then '60–80%' else '80–100%' end price_bucket,\n case when market_cost<500 then '<500' when market_cost<2000 then '500–2k'\n when market_cost<10000 then '2k–10k' else '10k+' end market_cost_bucket,\n abs(own-opposite) pre_gap,abs(own+shares-opposite) post_gap,\n notional/nullif(market_cost,0) fill_to_market_cost\n from snapshot where observed_outcomes=2 and notional>0\n)\nselect role,count(*)::int fills,count(distinct market_key)::int markets,\n round(avg(notional),2)::float8 mean_usdc,\n round(percentile_cont(.5) within group(order by notional)::numeric,2)::float8 median_usdc,\n round(percentile_cont(.9) within group(order by notional)::numeric,2)::float8 p90_usdc,\n round(percentile_cont(.99) within group(order by notional)::numeric,2)::float8 p99_usdc,\n count(*) filter(where market_cost>0)::int with_prior_market_cost,\n count(*) filter(where pre_gap>post_gap)::int reduced_gap,\n count(*) filter(where pre_gap<post_gap)::int increased_gap,\n count(*) filter(where own>0 and opposite>0)::int previously_held_both,\n round(percentile_cont(.5) within group(order by fill_to_market_cost)::numeric,5)::float8 median_size_to_prior_cost\nfrom s group by role order by role");
 const breakdown=await db.unsafe("with inventory as(\n select r.id run_id,p->>'market_key' market_key,p->>'token_id' token_id,\n (p->>'current_size')::numeric holdings,\n (p->>'entry_cost_usdc')::numeric cost\n from pi.rn1_quote_probe_runs r\n cross join lateral jsonb_array_elements(r.positions) p\n where r.position_status='complete'\n  and r.position_observed_at is not null and r.position_observed_at<=r.received_at\n), snapshot as (\n select f.fingerprint,f.role,f.market_key,f.token_id,\n  f.fill_price,f.shares,f.fill_price*f.shares notional,\n  coalesce(sum(i.holdings) filter(where i.token_id=f.token_id),0) own,\n  coalesce(sum(i.holdings) filter(where i.token_id<>f.token_id),0) opposite,\n  coalesce(sum(i.cost),0) market_cost,\n  count(i.token_id) observed_outcomes\n from pi.rn1_quote_probe_fills f\n join pi.rn1_quote_probe_runs r on r.id=f.run_id\n left join inventory i on i.run_id=f.run_id and i.market_key=f.market_key\n where r.position_status='complete' and r.position_observed_at is not null\n and r.position_observed_at<=r.received_at and r.received_at<f.trade_at\n group by f.fingerprint,f.role,f.market_key,f.token_id,f.fill_price,f.shares\n), s as (\n select *,case when own<opposite then 'underweight'\n when own>opposite then 'overweight' else 'equal' end inventory_state,\n case when fill_price<0.20 then '<20%' when fill_price<0.40 then '20–40%'\n when fill_price<0.60 then '40–60%' when fill_price<0.80 then '60–80%' else '80–100%' end price_bucket,\n case when market_cost<500 then '<500' when market_cost<2000 then '500–2k'\n when market_cost<10000 then '2k–10k' else '10k+' end market_cost_bucket,\n abs(own-opposite) pre_gap,abs(own+shares-opposite) post_gap,\n notional/nullif(market_cost,0) fill_to_market_cost\n from snapshot where observed_outcomes=2 and notional>0\n)\nselect b.dimension,b.bucket,count(*)::int fills,count(distinct market_key)::int markets,\n round(avg(notional),2)::float8 mean_usdc,\n round(percentile_cont(.5) within group(order by notional)::numeric,2)::float8 median_usdc,\n round(percentile_cont(.9) within group(order by notional)::numeric,2)::float8 p90_usdc,\n round(percentile_cont(.5) within group(order by shares)::numeric,2)::float8 median_shares,\n round(percentile_cont(.5) within group(order by fill_to_market_cost)::numeric,5)::float8 median_ratio\nfrom s\ncross join lateral (values\n ('inventory',s.inventory_state),\n ('price',s.price_bucket),\n ('prior_market_cost',s.market_cost_bucket)\n) b(dimension,bucket)\nwhere role='maker_inferred'\ngroup by b.dimension,b.bucket order by b.dimension,b.bucket");
 const audit=await db.unsafe("select count(*)::int verified_pages,sum(maker_fills)::bigint maker_fills,sum(taker_fills)::bigint taker_fills from pi.rn1_full_archive_pages where role_status='verified'");
 const probe=await db.unsafe("select status,completed_runs::int completed_runs,matched_fills::int matched_fills,last_success_at::text as last_success_at from pi.rn1_quote_probe_state limit 1");
 const archiveState=await db.unsafe("select stream,status,pages_fetched::int pages_fetched,rows_seen::bigint rows_seen,last_success_at::text last_success_at from pi.rn1_full_streams where stream='trades_all' limit 1");
 return {histogram:hist,role_summary:roles,maker_breakdown:breakdown,
  full_role_audit:audit[0]??{},probe:probe[0]??{},archive_state:archiveState[0]??{},
  definitions:{
   archive:"756,000 public BUY fills in immutable frozen archive; histogram includes Maker and Taker, without individual-role size splits.",
   live:"Causal pre-fill CLOB probe: only fills with complete positions for both outcomes, read before book receipt and strictly before the fill.",
   ratio:"Fill notional (shares × price) / sum of entry costs of both OPEN outcome positions observed just before the fill. NOT wallet bankroll fraction, portfolio capital at risk, or original order size.",
   gap:"Before/after absolute number-of-shares gap between outcomes, assuming this observed BUY is added and no other change between inventory snapshot and fill.",
   warnings:[
    "The quote-probe sample is selected on recently active RN1 markets and is not representative of the whole wallet.",
    "A public fill is not the underlying Maker order size: one order may execute across multiple fills.",
    "Open positions exclude previously settled, merged, redeemed, transferred or otherwise closed inventory.",
    "An available-market position snapshot is not free cash, trading bankroll, account equity, or leverage.",
    "Role labels in live probes are inferred Maker / verified Taker from public feed comparisons; they do not contain placement/cancellation timestamps.",
    "Historical 756k gross USDC turnover is NOT profit, bank balance or simultaneously deployed capital. No trade is executed by this dashboard."
   ]
  }};
}


type Rn1SizingObs={token:string;market:string;at:number;shares:number;notional:number;price:number;fill_count:number};
function rn1Median(items:number[]):number|null{
 if(!items.length)return null;
 const a=[...items].sort((x,y)=>x-y),n=a.length;
 return n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2;
}
function rn1SizingEvents(rows:any[],burstSeconds:number):Rn1SizingObs[]{
 const blocks=new Map<string,Rn1SizingObs>();
 for(const r of rows){
  const token=String(r.token_id),market=String(r.market_key),
   at=Number(r.trade_epoch),price=Number(r.price),shares=Number(r.shares);
  if(!token||!market||!Number.isFinite(at)||!Number.isFinite(price)||
      !Number.isFinite(shares)||price<=0||price>=1||shares<=0)continue;
  const key=burstSeconds?token+":"+Math.floor(at/burstSeconds):String(r.fingerprint);
  let block=blocks.get(key);
  if(!block){block={token,market,at,shares:0,notional:0,price:0,fill_count:0};blocks.set(key,block)}
  block.shares+=shares;block.notional+=price*shares;
  block.at=Math.min(block.at,at);block.fill_count++;
 }
 return [...blocks.values()].map(v=>({...v,price:v.notional/v.shares}))
 .sort((a,b)=>a.token.localeCompare(b.token)||a.at-b.at||a.market.localeCompare(b.market));
}
function rn1ModelScenario(rows:any[],burstSeconds:number,minPriceSpan:number,details=false){
 const events=rn1SizingEvents(rows,burstSeconds),byToken=new Map<string,Rn1SizingObs[]>();
 for(const r of events){const list=byToken.get(r.token)||[];list.push(r);byToken.set(r.token,list)}
 const eligible:{token:string;market:string;train:Rn1SizingObs[];test:Rn1SizingObs[];price_span:number;total_n:number}[]=[];
 for(const [token,a] of byToken){
  if(a.length<6)continue;
  const k=Math.floor(.7*a.length),train=a.slice(0,k),
   lastTrainSec=Math.floor(train[train.length-1].at),
   test=a.slice(k).filter(v=>Math.floor(v.at)>lastTrainSec);
  if(test.length<2)continue;
  const prices=train.map(v=>v.price),span=Math.max(...prices)-Math.min(...prices);
  if(span<minPriceSpan)continue;
  eligible.push({token,market:a[0].market,train,test,price_span:span,total_n:a.length});
 }
 const byMarket=new Map<string,{sxy:number;sxx:number}>();
 for(const g of eligible){
  const x=g.train.map(a=>Math.log(a.price)),y=g.train.map(a=>Math.log(a.shares));
  const xm=x.reduce((a,b)=>a+b,0)/x.length,ym=y.reduce((a,b)=>a+b,0)/y.length;
  const acc=byMarket.get(g.market)||{sxy:0,sxx:0};
  for(let i=0;i<x.length;i++){acc.sxy+=(x[i]-xm)*(y[i]-ym);acc.sxx+=(x[i]-xm)**2}
  byMarket.set(g.market,acc);
 }
 const all=[...byMarket.values()].reduce((a,b)=>({sxy:a.sxy+b.sxy,sxx:a.sxx+b.sxx}),{sxy:0,sxx:0});
 const beta=all.sxx>1e-10?all.sxy/all.sxx:null;
 const errors:{token:string;market:string;shares:number;usdc:number;learned:number|null}[]=[];
 const observations:any[]=[];
 for(const g of eligible){
  const medianShares=rn1Median(g.train.map(x=>x.shares))??1,
   medianUsd=rn1Median(g.train.map(x=>x.notional))??1,
   ownMarket=byMarket.get(g.market)||{sxy:0,sxx:0};
  // Power slope is fitted ONLY on training fills from OTHER markets.
  const denom=all.sxx-ownMarket.sxx,
   crossMarketBeta=denom>1e-10?(all.sxy-ownMarket.sxy)/denom:null;
  const intercept=crossMarketBeta===null?null:
   rn1Median(g.train.map(x=>Math.log(x.shares)-crossMarketBeta*Math.log(x.price)));
  const tokenErrors:any[]=[];
  for(const x of g.test){
   const a=Math.abs(Math.log(x.shares/medianShares)),
    b=Math.abs(Math.log(x.notional/medianUsd)),
    c=intercept===null||crossMarketBeta===null?null:
      Math.abs(Math.log(x.shares)-(intercept+crossMarketBeta*Math.log(x.price)));
   const err={token:g.token,market:g.market,shares:a,usdc:b,learned:c};
   tokenErrors.push(err);errors.push(err);
  }
  const mean=(k:"shares"|"usdc"|"learned")=>{
   const valid=tokenErrors.map(x=>x[k]).filter(x=>x!==null);
   return valid.length?valid.reduce((s:number,x:number)=>s+x,0)/valid.length:null;
  };
  if(details)observations.push({
   market:g.market.slice(0,12)+"…",token:g.token.slice(0,8)+"…"+g.token.slice(-6),
   observed_events:g.total_n,train_events:g.train.length,test_events:g.test.length,
   train_price_span:g.price_span,shares_mae:mean("shares"),usd_mae:mean("usdc"),
   learned_mae:mean("learned")
  });
 }
 const mean=(a:number[])=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
 const median=rn1Median;
 const model=(key:"shares"|"usdc"|"learned")=>{
  const v=errors.map(x=>x[key]).filter((x):x is number=>x!==null);
  return {n:v.length,mean_abs_log_error:mean(v),median_abs_log_error:median(v),
   median_error_factor:v.length?Math.exp(median(v)!):null};
 };
 const wins={shares:0,usd:0,tie:0},marketScores=new Map<string,{sh:number;usd:number;n:number}>();
 for(const o of observations){
  const d=Number(o.usd_mae)-Number(o.shares_mae);
  if(d>1e-6)wins.shares++;else if(d< -1e-6)wins.usd++;else wins.tie++;
 }
 // Even when details=false, compute token-by-token wins without touching test fitting.
 if(!details){
  const grouped=new Map<string,{sh:number;usd:number;n:number}>();
  for(const e of errors){const v=grouped.get(e.token)||{sh:0,usd:0,n:0};
   v.sh+=e.shares;v.usd+=e.usdc;v.n++;grouped.set(e.token,v)}
  for(const v of grouped.values()){const diff=v.usd-v.sh;
   if(diff>1e-6)wins.shares++;else if(diff< -1e-6)wins.usd++;else wins.tie++}
 }
 for(const e of errors){const v=marketScores.get(e.market)||{sh:0,usd:0,n:0};
  v.sh+=e.shares;v.usd+=e.usdc;v.n++;marketScores.set(e.market,v)}
 const marketsWins={shares:0,usd:0,tie:0};
 for(const v of marketScores.values()){
  const d=v.usd-v.sh;
  if(d>1e-6)marketsWins.shares++;else if(d< -1e-6)marketsWins.usd++;else marketsWins.tie++;
 }
 return {burst_seconds:burstSeconds,min_training_price_span:minPriceSpan,
  events_total:events.length,
  multi_fill_groups:events.filter(x=>x.fill_count>1).length,
  fills_in_multi_groups:events.reduce((s,x)=>s+(x.fill_count>1?x.fill_count:0),0),
  eligible_tokens:eligible.length,eligible_markets:byMarket.size,heldout_events:errors.length,
  fitted_beta:beta,models:{fixed_shares:model("shares"),
   fixed_usdc:model("usdc"),learned_power:model("learned")},
  token_wins:wins,market_wins:marketsWins,
  tokens:details?observations:undefined
 };
}
function rn1RollingScenario(rows:any[],lookback:number,minPriceSpan:number,burstSeconds:number){
 const events=rn1SizingEvents(rows,burstSeconds),group=new Map<string,Rn1SizingObs[]>();
 for(const x of events){const v=group.get(x.token)||[];v.push(x);group.set(x.token,v)}
 const cases:{token:string;market:string;shares:number;usdc:number}[]=[];
 for(const [token,arr] of group){
  for(let i=lookback;i<arr.length;i++){
   const x=arr[i],
    prior=arr.slice(0,i).filter(v=>Math.floor(v.at)<Math.floor(x.at)).slice(-lookback);
   if(prior.length<lookback)continue;
   const prices=prior.map(v=>v.price);
   if(Math.max(...prices)-Math.min(...prices)<minPriceSpan)continue;
   const shares=rn1Median(prior.map(v=>v.shares))!,usd=rn1Median(prior.map(v=>v.notional))!;
   cases.push({token,market:x.market,
    shares:Math.abs(Math.log(x.shares/shares)),
    usdc:Math.abs(Math.log(x.notional/usd))});
  }
 }
 const tokens=new Map<string,{s:number;u:number}>();
 for(const x of cases){
  const a=tokens.get(x.token)||{s:0,u:0};a.s+=x.shares;a.u+=x.usdc;tokens.set(x.token,a);
 }
 const avg=(key:"shares"|"usdc")=>cases.length?cases.reduce((a,b)=>a+b[key],0)/cases.length:null;
 return {lookback,burst_seconds:burstSeconds,training_min_price_span:minPriceSpan,
  n_predictions:cases.length,tokens:tokens.size,markets:new Set(cases.map(x=>x.market)).size,
  fixed_shares_mean_abs_log:avg("shares"),fixed_usdc_mean_abs_log:avg("usdc"),
  token_wins:{shares:[...tokens.values()].filter(x=>x.s<x.u-1e-6).length,
   usd:[...tokens.values()].filter(x=>x.u<x.s-1e-6).length,
   tie:[...tokens.values()].filter(x=>Math.abs(x.s-x.u)<=1e-6).length}
 };
}
async function rn1SizingHypotheses(){
 const rows=await db.unsafe("select fingerprint,market_key,token_id,extract(epoch from trade_at)::float8 trade_epoch,\n fill_price::float8 price,shares::float8 shares\n from pi.rn1_quote_probe_fills\n where role='maker_inferred' and side='BUY'\n and shares>0 and fill_price between 0.005 and 0.995\n order by trade_at desc,fingerprint desc limit 10001");
 const limited=rows.length>10000,sample=limited?rows.slice(0,10000):rows;
 const variations=[
  rn1ModelScenario(sample,0,0.03,true),
  rn1ModelScenario(sample,0,0.01),
  rn1ModelScenario(sample,0,0.05),
  rn1ModelScenario(sample,1,0.03),
  rn1ModelScenario(sample,10,0.03)
 ];
 const rolling=[
  rn1RollingScenario(sample,3,0.03,0),
  rn1RollingScenario(sample,5,0.03,0),
  rn1RollingScenario(sample,3,0.03,1),
  rn1RollingScenario(sample,3,0.01,0)
 ];
 return {source_fills:sample.length,truncated:limited,source_role:"maker_inferred",
  primary:variations[0],sensitivities:variations.slice(1),rolling,
  definitions:{
   split:"For each token with >=6 events, calibrate on first floor(70%) by time, then test only strictly LATER timestamps at least 1 second beyond the last training fill. Training price span must exceed 3c (1c and 5c sensitivities).",
   fixed_shares:"Predict constant number of shares = training token median(shares).",
   fixed_usdc:"Predict constant executed USDC = training token median(shares*fill_price).",
   learned_power:"Fit pooled, within-token log(shares) vs log(price) slope on TRAINING ONLY, excluding the entire held-out token market when predicting it. Token intercept from its training values.",
   loss:"Absolute natural-log multiplicative ratio, measured on later fills. A median error factor of 7 means the actual value is typically about 7x the prediction or the inverse, not 7% error.",
   bursts:"A same-token 1s or 10s group sums fills and uses their volume-weighted average price; it is a sensitivity proxy, NOT a verified parent order.",
   rolling:"The previous 3/5 observed fills from strictly earlier seconds predict each next fill. Online overlapping outcomes are statistically dependent.",
   constraints:[
    "This is a small selectively observed live Maker-inferred sample; not the historical 756k all-role universe.",
    "A Maker fill is a partial or complete EXECUTION, not a new or full private limit order. Unfilled and cancelled quotes remain invisible.",
    "Same-second transaction ordering is unknown; holdouts and rolling tests exclude ambiguous earlier observations at the same second.",
    "The 70/30 split is within the SAME tokens; there is NO new-token or true future-market generalization guarantee.",
    "Comparing sizes conditional on observed fills introduces fill-selection and price/liquidity confounding.",
    "Results are exploratory and not a validated sizing formula, probability of entry, profit, or bankroll management rule."
   ]
  }};
}


function rn1MarketFold(s:string):number{
 let hash=2166136261;
 for(let i=0;i<s.length;i++){hash^=s.charCodeAt(i);hash=Math.imul(hash,16777619)}
 return (hash>>>0)%5;
}
function rn1CrossMarketFit(rows:any[]){
 const names=[
 "global_fixed_shares","global_fixed_usdc",
 "price_bucket_shares","price_bucket_usdc",
 "price_inventory_shares","price_inventory_usdc",
 "price_cost_shares","price_cost_usdc","fraction_open_market_cost"
 ] as const;
 const models=names.map(name=>({name,errors:[] as number[],market_errors:new Map<string,number[]>()}));
 const pb=(p:number)=>Math.max(0,Math.min(4,Math.floor(p*5)));
 const state=(x:any)=>Number(x.own)<Number(x.other)?"under":Number(x.own)>Number(x.other)?"over":"equal";
 const costBucket=(v:number)=>v<500?"0":v<2000?"1":v<10000?"2":"3";
 const samples=rows.filter(x=>Number(x.price)>0&&Number(x.price)<1
  &&Number(x.shares)>0&&Number(x.usd)>0&&Number(x.prior_cost)>0);
 const foldCount:number[]=[];
 const allPerMarket=new Map<string,number[]>();
 for(let fold=0;fold<5;fold++){
  const train=samples.filter(x=>rn1MarketFold(String(x.market_key))!==fold),
   test=samples.filter(x=>rn1MarketFold(String(x.market_key))===fold);
  foldCount.push(test.length);
  if(train.length<5||!test.length)continue;
  const globalShares=rn1Median(train.map(x=>Number(x.shares)))!,
   globalUsd=rn1Median(train.map(x=>Number(x.usd)))!,
   fraction=rn1Median(train.map(x=>Number(x.usd)/Number(x.prior_cost)))!;
  const buckets=new Map<string,any[]>();
  for(const x of train){
   for(const key of ["p"+pb(Number(x.price)),
     "i"+pb(Number(x.price))+state(x),
     "c"+pb(Number(x.price))+costBucket(Number(x.prior_cost))]){
    const values=buckets.get(key)||[];values.push(x);buckets.set(key,values);
   }
  }
  const medFor=(key:string)=>{
   const a=buckets.get(key)||[];
   return a.length>=5?{shares:rn1Median(a.map(x=>Number(x.shares)))!,
    usd:rn1Median(a.map(x=>Number(x.usd)))!}:null;
  };
  for(const x of test){
   const price=Number(x.price),cost=Number(x.prior_cost),
    b=pb(price),bucket=medFor("p"+b)||{shares:globalShares,usd:globalUsd},
    inv=medFor("i"+b+state(x))||bucket,
    exposure=medFor("c"+b+costBucket(cost))||bucket;
   const predictors=[
    globalShares,globalUsd,bucket.shares,bucket.usd,
    inv.shares,inv.usd,exposure.shares,exposure.usd,fraction*cost];
   let merror=allPerMarket.get(String(x.market_key));
   if(!merror){merror=Array(names.length).fill(0);allPerMarket.set(String(x.market_key),merror)}
   for(let k=0;k<names.length;k++){
    const real=k===0||k===2||k===4||k===6?Number(x.shares):Number(x.usd);
    const error=Math.abs(Math.log(real/predictors[k]));
    models[k].errors.push(error);
    const arr=models[k].market_errors.get(String(x.market_key))||[];
    arr.push(error);models[k].market_errors.set(String(x.market_key),arr);
    merror[k]+=error;
   }
  }
 }
 const outcome=models.map(m=>{
  const v=m.errors,med=rn1Median(v),
   avg=(arr:number[])=>arr.reduce((s,x)=>s+x,0)/arr.length,
   perMarket=[...m.market_errors.values()].map(avg);
  return {model:m.name,n:v.length,mean_abs_log_error:v.length?avg(v):null,
   median_abs_log_error:med,median_error_factor:med===null?null:Math.exp(med),
   equal_market_mean_abs_log_error:perMarket.length?avg(perMarket):null};
 }).sort((a,b)=>Number(a.mean_abs_log_error)-Number(b.mean_abs_log_error));
 const first=outcome[0]?.model||null;
 return {n_fills:samples.length,markets:new Set(samples.map(x=>x.market_key)).size,
  tokens:new Set(samples.map(x=>x.token_id)).size,
  fold_n:foldCount,models:outcome,lowest_mean_log_model:first,
  definitions:[
   "Five deterministic folds by MARKET, not token: both outcomes of a market always enter the same held-out fold.",
   "Training from other markets only. This is cross-MARKET validation but not time-causal because train markets may contain later timestamps.",
   "Source restricted to Maker-inferred fills with both outcomes in a public position snapshot <=60 seconds before the fill, and positive previously-open cost.",
   "Fixed shares and USDC calibrate global medians. Price buckets are five 20-cent bands. Inventory state = underweight/overweight/equal in shares. Market-cost buckets = <500 / 500–2k / 2k–10k / >=10k USDC.",
   "At least five observations are required within a training bucket; rarer buckets back off to the price bucket and then the global model.",
   "Market-cost fraction model uses median(fill_USDC / prior OPEN market cost) from training markets. It is NOT a fraction of wallet bankroll.",
   "Log error and median error factor evaluate observed fill sizes ONLY. No latent parent-order quantity, hit probability or order cancellations are available.",
   "Performance differences across exploratory model variants are not causal, multiple hypotheses were tried, and large errors prohibit copying the rule."
  ]};
}
async function rn1SizingMarketValidation(){
 const rows=await db.unsafe("with positions as(\n select r.id run_id,x->>'market_key' market_key,x->>'token_id' token_id,\n  (x->>'current_size')::numeric size,(x->>'entry_cost_usdc')::numeric cost\n from pi.rn1_quote_probe_runs r\n cross join lateral jsonb_array_elements(r.positions) x\n where r.position_status='complete'\n  and r.position_observed_at<=r.received_at\n),f as(\n select t.fingerprint,t.market_key,t.token_id,\n  t.fill_price::float8 price,t.shares::float8 shares,\n  (t.shares*t.fill_price)::float8 usd,\n  extract(epoch from(t.trade_at-r.position_observed_at))::float8 age,\n  sum(positions.cost)::float8 prior_cost,\n  coalesce(sum(positions.size) filter(where positions.token_id=t.token_id),0)::float8 own,\n  coalesce(sum(positions.size) filter(where positions.token_id<>t.token_id),0)::float8 other,\n  count(positions.token_id)::int outcomes,\n  count(distinct positions.token_id)::int distinct_tokens\n from pi.rn1_quote_probe_fills t join pi.rn1_quote_probe_runs r on r.id=t.run_id\n left join positions on positions.run_id=r.id and positions.market_key=t.market_key\n where t.role='maker_inferred' and t.side='BUY'\n  and t.shares>0 and t.fill_price between .005 and .995\n  and r.position_status='complete'\n  and r.position_observed_at<=r.received_at and r.received_at<t.trade_at\n group by t.fingerprint,t.market_key,t.token_id,t.fill_price,t.shares,t.trade_at,r.position_observed_at\n)\nselect fingerprint,market_key,token_id,price,shares,usd,age,prior_cost,own,other\nfrom f where outcomes=2 and distinct_tokens=2 and prior_cost>0 and age<=60\norder by fingerprint desc limit 2501");
 const truncated=rows.length>2500;
 return {truncated,...rn1CrossMarketFit(truncated?rows.slice(0,2500):rows)};
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
  if(body?.action==="rn1_reverse_engineering")return send(await rn1ReverseEngineering());
  if(body?.action==="rn1_setup_patterns")return send(await rn1SetupPatterns());
  if(body?.action==="rn1_trigger_windows")return send(await rn1TriggerWindows(body));
  if(body?.action==="rn1_sports_impact")return send(await rn1SportsImpact(body));
  if(body?.action==="rn1_sports_robustness")return send(await rn1SportsRobustness());
  if(body?.action==="rn1_sizing_forensics")return send(await rn1SizingForensics());
  if(body?.action==="rn1_sizing_hypotheses")return send(await rn1SizingHypotheses());
  if(body?.action==="rn1_sizing_market_validation")return send(await rn1SizingMarketValidation());
  if(body?.action==="rn1_quote_forensics")return send(await rn1QuoteForensics());
  if(body?.action==="rn1_strategy_evidence")return send(await rn1StrategyEvidence());
  if(body?.action==="rn1_activity_research")return send(await rn1ActivityResearch());
  return send({error:"Action inconnue"},400);
 }catch(e){
  console.error("pi-dashboard",e instanceof Error?e.message.slice(0,160):"unknown");
  return send({error:"Erreur lors de la lecture des données"},500);
 }
});
