// Bounded Polymarket ingestion. Admin API needs service role; scheduled route requires a private Vault-backed token.
// Backend writes private pi schema, with no credentials exposed in the browser.
import postgres from "npm:postgres@3.4.3";
import {captureTemporalBooks} from "./arb-capture.ts";
import {RN1,normalizeV2Trade,pageEnvelope,sha256} from "./rn1-trade-utils.ts";
import {normalizeActivity,envelopeActivity,sha256Activity} from "./rn1-activity-utils.ts";
import { closedRoi } from "./roi-math.ts";
import { closesPageComplete } from "./roi-sync.ts";

const connectionString = Deno.env.get("SUPABASE_DB_URL");
if (!connectionString) throw new Error("SUPABASE_DB_URL is not configured");
const db = postgres(connectionString, { max: 1, prepare: false, connect_timeout: 10 });
const ADDRESS = /^0x[0-9a-f]{40}$/;
const BASE = "https://data-api.polymarket.com";

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, { status, headers: { "cache-control": "no-store" } });
}
function number(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean" || value === "") return null;
  const v = Number(value);
  return Number.isFinite(v) ? v : null;
}
async function get(path: string, params: Record<string, string>): Promise<any> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(14000),
    });
    if ((response.status === 429 || response.status === 503) && attempt < 2) {
      const retry = number(response.headers.get("retry-after")) ?? attempt + 1;
      await new Promise((resolve) => setTimeout(resolve, Math.min(12000, Math.max(1000, retry * 1000))));
      continue;
    }
    if (!response.ok) throw new Error("Polymarket HTTP " + response.status + " for " + path);
    return await response.json();
  }
  throw new Error("Retry budget exhausted");
}
type Point = { day: string; ts: number; economic: number | null; realized: number | null; positions: number | null };
function normalizePoints(body: any): Point[] {
  const points = Array.isArray(body?.data?.points) ? body.data.points : [];
  const byDay = new Map<string, Point>();
  for (const p of points) {
    const ts = number(p?.timestamp);
    if (ts === null || ts < 946684800 || ts >= 4102444800) continue;
    const day = new Date(ts * 1000).toISOString().slice(0, 10);
    const economic = number(p.economic_pnl);
    const realized = number(p.realized_pnl);
    const positions = number(p.position_pnl);
    if (economic === null && realized === null && positions === null) continue;
    const previous = byDay.get(day);
    if (!previous || ts > previous.ts) byDay.set(day, { day, ts, economic, realized, positions });
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}
function pnlStats(points: Point[]) {
  const rows = points.filter((p) => p.economic !== null);
  if (rows.length < 2) return null;
  let peak = rows[0].economic!, dd = 0, ups = 0, gaps = 0, active = 0;
  let grossUp = 0, biggestUp = 0;
  const first = rows[0].day;
  const values = rows.map((p) => p.economic!);
  const xx = rows.map((p) => (Date.parse(p.day) - Date.parse(first)) / 86400000);
  for (let i = 1; i < rows.length; i++) {
    const x = values[i], change = x - values[i - 1];
    peak = Math.max(peak, x);
    dd = Math.max(dd, peak - x);
    if (change !== 0) active++;
    if (change > 0) {
      ups++; grossUp += change; biggestUp = Math.max(biggestUp, change);
    }
    gaps += Math.max(0, xx[i] - xx[i - 1] - 1);
  }
  const n = rows.length, mx = xx.reduce((a, b) => a + b, 0) / n;
  const my = values.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xx[i] - mx, dy = values[i] - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const slope = sxx > 0 ? sxy / sxx : null;
  const r2 = sxx > 0 && syy > 0 ? Math.min(1, Math.max(0, sxy * sxy / (sxx * syy))) : null;
  const change = values[n - 1] - values[0];
  return {
    day: rows[n - 1].day, first_day: first, days: n, missing_days: gaps,
    dd_usdc: dd, change_usdc: change, recovery_factor: dd > 0 ? change / dd : null,
    percent_positive: 100 * ups / (n - 1), active_days: active,
    positive_active_pct: active > 0 ? 100 * ups / active : null,
    concentration_pct: grossUp > 0 ? 100 * biggestUp / grossUp : null,
    pnl_linearity_r2: r2, slope_usdc_per_day: slope,
  };
}

async function discover(limit: number) {
  const wallets = new Map<string, string>();
  for (const sort of ["PNL", "VOLUME"]) {
    const result = await get("/v2/leaderboard", {
      time_period: "all", sort_by: sort, category: "overall", limit: String(limit),
    });
    for (const p of Array.isArray(result?.data) ? result.data : []) {
      const wallet = String(p?.user_id ?? p?.proxy_wallet ?? p?.wallet ?? "").toLowerCase();
      if (!ADDRESS.test(wallet)) continue;
      const name = String(p?.user_name ?? p?.name ?? "").slice(0, 120);
      wallets.set(wallet, name);
    }
  }
  for (const [wallet, name] of wallets) {
    await db.unsafe("insert into pi.wallets(wallet, display_name, last_seen_at) values ($1,$2,now()) on conflict(wallet) do update set last_seen_at=now(),display_name=coalesce(nullif(excluded.display_name,''),pi.wallets.display_name)",
      [wallet, name || null]);
  }
  return { discovered: wallets.size, cohort: "leaderboard selection, survivorship biased" };
}
async function refresh(wallet: string) {
  const data = await get("/v2/user-pnl", { user: wallet, interval: "all", fidelity: "1d" });
  const points = normalizePoints(data);
  if (points.length === 0) throw new Error("No daily PnL data for this wallet");
  const summary = pnlStats(points);
  const previous = await db.unsafe("select exists(select 1 from pi.wallet_pnl_daily where wallet=$1) as has_data,max(day)::text as last_day from pi.wallet_pnl_daily where wallet=$1", [wallet]);
  const alreadyStored = previous[0]?.has_data === true;
  // Reimport a 7-day revision window; full backfill only on first collection.
  // The full returned series is still used to recalculate summary metrics.
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const batch = alreadyStored ? points.filter((p) => p.day >= cutoff) : points;
  await db.begin(async (tx) => {
    await tx.unsafe("insert into pi.wallets(wallet,last_seen_at) values ($1,now()) on conflict(wallet) do update set last_seen_at=now()", [wallet]);
    if (batch.length > 0) {
      await tx.unsafe(
        "insert into pi.wallet_pnl_daily(wallet,day,source,economic_pnl_usdc,realized_pnl_usdc,position_pnl_usdc,completeness,collected_at) select $1,x.day::date,'polymarket_v2_user_pnl',x.economic,x.realized,x.positions,'partial',now() from jsonb_to_recordset(($2::text)::jsonb) as x(day text,economic numeric,realized numeric,positions numeric) on conflict(wallet,day,source) do update set economic_pnl_usdc=excluded.economic_pnl_usdc,realized_pnl_usdc=excluded.realized_pnl_usdc,position_pnl_usdc=excluded.position_pnl_usdc,collected_at=now()",
        [wallet, JSON.stringify(batch)]);
    }
    if (summary) {
      await tx.unsafe(
        "insert into pi.wallet_metrics_daily(wallet,day,max_observed_pnl_drawdown_usdc,positive_daily_change_pct,observation_days,pnl_observed_change_usdc,pnl_recovery_factor,pnl_slope_usdc_per_day,missing_pnl_days,pnl_observed_from,pnl_observed_through,pnl_linearity_r2,active_pnl_change_days,positive_active_change_pct,largest_positive_day_share_pct,quality_status,incomplete_reason,computed_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pnl_only',$16,now()) on conflict(wallet,day) do update set max_observed_pnl_drawdown_usdc=excluded.max_observed_pnl_drawdown_usdc,positive_daily_change_pct=excluded.positive_daily_change_pct,observation_days=excluded.observation_days,pnl_observed_change_usdc=excluded.pnl_observed_change_usdc,pnl_recovery_factor=excluded.pnl_recovery_factor,pnl_slope_usdc_per_day=excluded.pnl_slope_usdc_per_day,missing_pnl_days=excluded.missing_pnl_days,pnl_observed_from=excluded.pnl_observed_from,pnl_observed_through=excluded.pnl_observed_through,pnl_linearity_r2=excluded.pnl_linearity_r2,active_pnl_change_days=excluded.active_pnl_change_days,positive_active_change_pct=excluded.positive_active_change_pct,largest_positive_day_share_pct=excluded.largest_positive_day_share_pct,quality_status='pnl_only',incomplete_reason=excluded.incomplete_reason,computed_at=now()",
        [wallet, summary.day, summary.dd_usdc, summary.percent_positive, summary.days,
          summary.change_usdc, summary.recovery_factor, summary.slope_usdc_per_day,
          summary.missing_days, summary.first_day, summary.day, summary.pnl_linearity_r2,
          summary.active_days, summary.positive_active_pct, summary.concentration_pct,
          "Observed PnL only (not capital return); missing days: " + summary.missing_days]);
    }
  });
  // New PnL observation is a useful hint to check freshly closed markets
  // at the next ROI tick; intraday changes are also caught by 6-hour polling.
  if (summary && previous[0]?.last_day && summary.day > String(previous[0].last_day)) {
    await db.unsafe(
      "update pi.roi_import_state set last_recent_at=null,request_priority=true,updated_at=now() where wallet=$1 and sync_mode='idle'",
      [wallet]);
  }
  return { wallet, daily_observations: points.length, rows_upserted: batch.length,
    last_day: summary?.day ?? null, missing_days: summary?.missing_days ?? null,
    dd_usdc: summary?.dd_usdc ?? null, capital_roi: null };
}
async function scheduled(limit: number) {
  const walletRows = await db.unsafe(
    "select w.wallet from pi.wallets w left join pi.ingestion_cursors c on c.wallet=w.wallet and c.stream='user_pnl' where coalesce(c.consecutive_failures,0)<5 or c.last_attempt_at < now()-interval '24 hours' order by c.last_attempt_at asc nulls first,w.wallet limit $1",
    [limit]);
  const report: {wallet:string; status:string; rows?:number; error?:string}[] = [];
  for (const row of walletRows) {
    const wallet = String(row.wallet);
    await db.unsafe(
      "insert into pi.ingestion_cursors(wallet,stream,last_attempt_at) values ($1,'user_pnl',now()) on conflict(wallet,stream) do update set last_attempt_at=now()",
      [wallet]);
    const job = await db.unsafe(
      "insert into pi.ingestion_jobs(wallet,stream,status,started_at) values ($1,'user_pnl','running',now()) returning id",
      [wallet]);
    try {
      const result = await refresh(wallet);
      await db.unsafe(
        "update pi.ingestion_cursors set last_success_at=now(),last_seen_at=now(),consecutive_failures=0,last_error=null where wallet=$1 and stream='user_pnl'",
        [wallet]);
      await db.unsafe(
        "update pi.ingestion_jobs set status='done',finished_at=now(),updated_at=now(),rows_fetched=$2 where id=$1",
        [job[0].id, result.rows_upserted]);
      report.push({wallet,status:"done",rows:result.rows_upserted});
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 180) : "unknown failure";
      await db.unsafe(
        "update pi.ingestion_cursors set consecutive_failures=consecutive_failures+1,last_error=$2 where wallet=$1 and stream='user_pnl'",
        [wallet,message]);
      await db.unsafe(
        "update pi.ingestion_jobs set status='failed',finished_at=now(),updated_at=now(),error_message=$2 where id=$1",
        [job[0].id,message]);
      report.push({wallet,status:"failed",error:message});
    }
  }
  return {attempted:report.length,ok:report.filter((r)=>r.status==="done").length,errors:report.filter((r)=>r.status==="failed").length,report};
}
// Each page contains positions, NOT individual order fills. No ROI for still-held shares.
// All tracked wallets are automatically onboarded. Full initial history is
// acquired once; 14-day overlap scans detect new and revised closes, and
// monthly full audits reconcile older corrections and deleted API rows.
async function refreshClosedPositions(wallet:string,maxPages=2){
 if(!ADDRESS.test(wallet))throw new Error("Invalid wallet");
 let pages=0,rows=0,done=false;
 for(let n=0;n<maxPages;n++){
  const states=await db.unsafe(
   "select generation,next_cursor,exhausted,sync_mode,checkpoint_at,scan_started_at from pi.roi_import_state where wallet=$1",
   [wallet]);
  if(!states.length||states[0].sync_mode==="idle"){done=true;break;}
  const st=states[0],generation=Number(st.generation),oldCursor=st.next_cursor as string|null;
  const mode=String(st.sync_mode);
  const args:Record<string,string>={user:wallet,status:"CLOSED",sort_by:"TIMESTAMP",sort_direction:"DESC",limit:"200"};
  if(oldCursor)args.cursor=oldCursor;
  const response=await get("/v2/positions",args);
  if(!Array.isArray(response?.data)||!response?.pagination||typeof response.pagination!=="object")
   throw new Error("Invalid Polymarket closed-positions envelope");
  if(response.data.length>200)throw new Error("Unexpected position page size");
  const hasMore=response.pagination.has_more===true;
  const next=typeof response.pagination.next_cursor==="string"&&response.pagination.next_cursor.length>0
   ?response.pagination.next_cursor:null;
  if(hasMore&&!next)throw new Error("Missing next cursor");
  if(hasMore&&next===oldCursor)throw new Error("Cursor did not advance");
  const newRows:any[]=[];
  const sourceTimestamps:(number|null)[]=[];
  for(const raw of response.data){
   const token=String(raw.token_id??"");
   if(String(raw.proxy_wallet??"").toLowerCase()!==wallet||!/^[0-9]+$/.test(token))
    throw new Error("Unexpected closed-position identity");
   const x=closedRoi(raw);
   const epoch=(value:unknown)=>{
    const ts=number(value);
    return ts!==null&&ts>=946684800&&ts<4102444800?new Date(ts*1000).toISOString():null;
   };
   const when=epoch(raw.last_event_at);
   sourceTimestamps.push(when?Date.parse(when):null);
   newRows.push({
    token_id:token,condition_id:String(raw.condition_id??"").slice(0,100),
    title:String(raw.title??"").slice(0,500),outcome:String(raw.outcome??"").slice(0,80),
    market_slug:String(raw.slug??"").slice(0,240),
    first_entry_at:epoch(raw.first_entry_at),last_event_at:when,
    lifetime_shares:number(raw.total_size),avg_entry_price:number(raw.avg_price),
    estimated_entry_cost_usdc:x.cost,realized_pnl_usdc:x.pnl,
    estimated_roi_pct:x.roi,valid_cost:x.valid,quality_reason:x.reason,
    source_percent_realized_pnl:number(raw.percent_realized_pnl)
   });
  }
  // Never stop a cursor early unless the entire page is dated and sorted.
  const complete=closesPageComplete(mode,hasMore,sourceTimestamps,
   st.checkpoint_at?new Date(st.checkpoint_at).getTime():null);
  await db.begin(async(tx)=>{
   if(newRows.length)await tx.unsafe(
    "insert into pi.closed_position_roi(wallet,token_id,generation,condition_id,title,outcome,market_slug,first_entry_at,last_event_at,lifetime_shares,avg_entry_price,estimated_entry_cost_usdc,realized_pnl_usdc,estimated_roi_pct,valid_cost,quality_reason,source_percent_realized_pnl,collected_at,last_seen_scan_at) select $1,x.token_id,$3,x.condition_id,x.title,x.outcome,x.market_slug,x.first_entry_at,x.last_event_at,x.lifetime_shares,x.avg_entry_price,x.estimated_entry_cost_usdc,x.realized_pnl_usdc,x.estimated_roi_pct,x.valid_cost,x.quality_reason,x.source_percent_realized_pnl,now(),now() from jsonb_to_recordset(($2::text)::jsonb) as x(token_id text,condition_id text,title text,outcome text,market_slug text,first_entry_at timestamptz,last_event_at timestamptz,lifetime_shares numeric,avg_entry_price numeric,estimated_entry_cost_usdc numeric,realized_pnl_usdc numeric,estimated_roi_pct numeric,valid_cost boolean,quality_reason text,source_percent_realized_pnl numeric) on conflict(wallet,token_id) do update set generation=excluded.generation,condition_id=excluded.condition_id,title=excluded.title,outcome=excluded.outcome,market_slug=excluded.market_slug,first_entry_at=excluded.first_entry_at,last_event_at=excluded.last_event_at,lifetime_shares=excluded.lifetime_shares,avg_entry_price=excluded.avg_entry_price,estimated_entry_cost_usdc=excluded.estimated_entry_cost_usdc,realized_pnl_usdc=excluded.realized_pnl_usdc,estimated_roi_pct=excluded.estimated_roi_pct,valid_cost=excluded.valid_cost,quality_reason=excluded.quality_reason,source_percent_realized_pnl=excluded.source_percent_realized_pnl,collected_at=now(),last_seen_scan_at=now()",
    [wallet,JSON.stringify(newRows),generation]);
   const advance=await tx.unsafe(
    "update pi.roi_import_state set next_cursor=case when $4::boolean then null else $3 end,exhausted=$4,sync_mode=case when $4::boolean then 'idle' else sync_mode end,request_priority=case when $4::boolean then false else request_priority end,pages_fetched=pages_fetched+1,rows_seen=rows_seen+$5,last_attempt_at=now(),last_success_at=now(),consecutive_failures=0,last_error=null,last_complete_at=case when $4::boolean and $7 in ('initial','full') then now() else last_complete_at end,last_full_audit_at=case when $4::boolean and $7 in ('initial','full') then now() else last_full_audit_at end,last_recent_at=case when $4::boolean then now() else last_recent_at end,updated_at=now() where wallet=$1 and generation=$2 and next_cursor is not distinct from $6 and sync_mode=$7 returning wallet",
    [wallet,generation,next,complete,newRows.length,oldCursor,mode]);
   if(!advance.length)throw new Error("Concurrent ROI scan advanced the cursor");
   if(complete&&mode==="full"&&st.scan_started_at)
    await tx.unsafe(
     "delete from pi.closed_position_roi where wallet=$1 and generation=$2 and (last_seen_scan_at is null or last_seen_scan_at < $3::timestamptz)",
     [wallet,generation,st.scan_started_at]);
   if(complete&&mode==="initial")
    await tx.unsafe("delete from pi.closed_position_roi where wallet=$1 and generation<>$2",[wallet,generation]);
  });
  pages++;rows+=newRows.length;done=complete;
  if(done)break;
 }
 return {wallet,pages,rows,complete:done};
}
async function syncQueuedRoi(){
 // Automatically discover even NEW tracked wallets without any browser clicks.
 await db.unsafe(
  "insert into pi.roi_import_state(wallet,request_priority) select wallet,false from pi.wallets on conflict(wallet) do nothing");
 const next=await db.unsafe(
  "select wallet,sync_mode,request_priority from pi.roi_import_state where (consecutive_failures<5 or last_attempt_at<now()-interval '24 hours') and ((sync_mode<>'idle' and (last_attempt_at is null or last_attempt_at<now()-interval '90 seconds')) or (sync_mode='idle' and (last_recent_at is null or last_recent_at<now()-interval '6 hours' or last_full_audit_at is null or last_full_audit_at<now()-interval '30 days'))) order by request_priority desc,case when sync_mode='idle' then 0 else 1 end,last_attempt_at asc nulls first limit 1");
 if(!next.length)return {status:"idle",reason:"No due wallets"};
 const wallet=String(next[0].wallet);
 if(next[0].sync_mode==="idle"){
  const audit=await db.unsafe(
   "update pi.roi_import_state set sync_mode=case when last_full_audit_at is null or last_full_audit_at<now()-interval '30 days' then 'full' else 'recent' end,exhausted=false,next_cursor=null,scan_started_at=now(),checkpoint_at=now()-interval '14 days',pages_fetched=0,rows_seen=0,last_attempt_at=null,last_error=null,updated_at=now() where wallet=$1 and sync_mode='idle' returning sync_mode",
   [wallet]);
  if(!audit.length)return {status:"race_lost",wallet};
 }
 const job=await db.unsafe(
  "insert into pi.ingestion_jobs(wallet,stream,status,started_at) values ($1,'closed_position_roi','running',now()) returning id",
  [wallet]);
 try{
  const result=await refreshClosedPositions(wallet,2);
  await db.unsafe(
   "update pi.ingestion_jobs set status='done',finished_at=now(),updated_at=now(),pages_fetched=$2,rows_fetched=$3 where id=$1",
   [job[0].id,result.pages,result.rows]);
  return result;
 }catch(e){
  const message=e instanceof Error?e.message.slice(0,180):"Unknown position feed failure";
  await db.unsafe(
   "update pi.roi_import_state set consecutive_failures=consecutive_failures+1,last_error=$2,last_attempt_at=now(),updated_at=now() where wallet=$1",
   [wallet,message]);
  await db.unsafe(
   "update pi.ingestion_jobs set status='failed',error_message=$2,finished_at=now(),updated_at=now() where id=$1",
   [job[0].id,message]);
  return {wallet,error:message};
 }
}

async function scheduledTemporal(){
 // The public API is read-only. The scheduler stores snapshots without creating orders or wallet positions.
 const last=await db.unsafe("select max(observed_at)::text as t from pi.arb_temporal_snapshots");
 if(last[0]?.t && Date.now()-Date.parse(last[0].t)<8*60*1000)
  return {status:"skipped",reason:"Recent snapshot already stored",last_at:last[0].t};
 const job=await db.unsafe(
  "insert into pi.ingestion_jobs(wallet,stream,status,started_at) values (null,'arb_temporal','running',now()) returning id");
 try{
  const result=await captureTemporalBooks(12,50);
  const rows=result.rows;
  if(!rows.length)throw Error("No compatible CTF binary books in Gamma sample");
  const inserted=await db.unsafe(
   `insert into pi.arb_temporal_snapshots
    (batch_id,observed_at,market_key,market_slug,event_slug,question,yes_token_id,no_token_id,quote_shares,
     yes_buy_avg,no_buy_avg,yes_sell_avg,no_sell_avg,yes_best_bid,no_best_bid,yes_best_ask,no_best_ask)
    select x.batch_id,x.observed_at,x.market_key,x.market_slug,x.event_slug,x.question,
      x.yes_token_id,x.no_token_id,x.quote_shares,x.yes_buy_avg,x.no_buy_avg,x.yes_sell_avg,
      x.no_sell_avg,x.yes_best_bid,x.no_best_bid,x.yes_best_ask,x.no_best_ask
    from jsonb_to_recordset(($1::text)::jsonb) as x(
      batch_id uuid,observed_at timestamptz,market_key text,market_slug text,event_slug text,question text,
      yes_token_id text,no_token_id text,quote_shares numeric,
      yes_buy_avg numeric,no_buy_avg numeric,yes_sell_avg numeric,no_sell_avg numeric,
      yes_best_bid numeric,no_best_bid numeric,yes_best_ask numeric,no_best_ask numeric)
    on conflict(batch_id,market_key) do nothing returning snapshot_id`,
   [JSON.stringify(rows)]);
  // Metadata-only backfill for older snapshots of the same condition ID.
  // Never rewrite historical quotes or invent execution prices.
  await db.unsafe(`update pi.arb_temporal_snapshots historical set event_slug=latest.event_slug
    from (select distinct on(market_key) market_key,event_slug from pi.arb_temporal_snapshots
          where event_slug is not null order by market_key,observed_at desc) latest
    where historical.market_key=latest.market_key and historical.event_slug is null`);
  // Keep costs bounded in the pre-existing project shared with Fit Tracker.
  await db.unsafe("delete from pi.arb_temporal_snapshots where observed_at<now()-interval '14 days'");
  await db.unsafe("update pi.ingestion_jobs set status='done',pages_fetched=2,rows_fetched=$2,finished_at=now(),updated_at=now() where id=$1",
   [job[0].id,inserted.length]);
  return {status:"done",markets_seen:result.markets_seen,markets_selected:result.selected,
   stored:inserted.length,observed_at:result.observed_at};
 }catch(e){
  const error=e instanceof Error?e.message.slice(0,160):"unknown collector error";
  await db.unsafe("update pi.ingestion_jobs set status='failed',finished_at=now(),updated_at=now(),error_message=$2 where id=$1",
   [job[0].id,error]);
  console.error("arb-temporal",error);
  return {status:"failed",error};
 }
}



async function scheduledRN1Activity(){
 // Bounded, audit-preserving source activity ingestion. Zero PnL assumptions, no orders.
 await db.unsafe("insert into pi.rn1_activity_import_state(wallet) values($1) on conflict do nothing",[RN1]);
 const claim=await db.unsafe(`
   update pi.rn1_activity_import_state
   set lease_until=now()+interval '110 seconds',updated_at=now()
   where wallet=$1 and status='collecting' and (lease_until is null or lease_until<now())
   returning next_cursor,rows_seen,sample_limit`,[RN1]);
 if(!claim.length)return {status:"idle_or_leased"};
 const job=await db.unsafe("insert into pi.ingestion_jobs(wallet,stream,status,started_at) values($1,'rn1_v2_activity','running',now()) returning id",[RN1]);
 let cursor=claim[0].next_cursor as string|null;
 let seen=0,stored=0,rejected=0,pages=0,status="collecting";
 try{
  for(let page=0;page<2;page++){
   const params:Record<string,string>={user:RN1,limit:"200",start:"1"};
   if(cursor)params.cursor=cursor;
   const sourcePayload=await get("/v2/activity",params);
   const envelope=envelopeActivity(sourcePayload);
   if(!envelope)throw Error("Unexpected V2 activity envelope");
   const {data,hasMore,nextCursor}=envelope;
   if(hasMore&&nextCursor===cursor)throw Error("V2 activity cursor failed to advance");
   const nextTotal=Number(claim[0].rows_seen)+seen+data.length;
   if(nextTotal>Number(claim[0].sample_limit))throw Error("Activity page exceeds pilot cap");
   const raw={source_response:sourcePayload,request:{user:RN1,start:1,limit:200,requested_cursor:cursor}};
   const pageSHA=await sha256Activity(JSON.stringify(raw));
   const normalized:Record<string,unknown>[]=[];
   for(let i=0;i<data.length;i++){
    const row=normalizeActivity(data[i],RN1);
    if(!row){rejected++;continue;}
    normalized.push({...row,activity_key:"v2-activity:"+await sha256Activity(pageSHA+":"+i),
      raw_archive_key:"rn1-activity-v2:"+pageSHA,source_row_index:i});
   }
   const terminal=!hasMore,capReached=nextTotal>=Number(claim[0].sample_limit);
   const oldCursor=cursor;
   let inserted=0;
   await db.begin(async tx=>{
    const timeValues=data.map((r:any)=>Number(r.timestamp)).filter((t:number)=>Number.isSafeInteger(t)&&t>=946684800&&t<4102444800);
    const archived=await tx.unsafe(`
     insert into pi.rn1_activity_pages
       (page_sha,wallet,requested_cursor,returned_cursor,row_count,first_event_at,last_event_at,raw_payload)
     values($1,$2,$3,$4,$5,$6,$7,($8::text)::jsonb)
     on conflict(page_sha) do nothing returning page_sha`,
     [pageSHA,RN1,oldCursor,nextCursor,data.length,
      timeValues.length?new Date(Math.min(...timeValues)*1000).toISOString():null,
      timeValues.length?new Date(Math.max(...timeValues)*1000).toISOString():null,
      JSON.stringify(raw)]);
    if(!archived.length)throw Error("Repeated raw activity page; cursor not advancing");
    if(normalized.length){
     const rows=await tx.unsafe(`
     insert into pi.wallet_activity(
      wallet,activity_key,occurred_at,kind,amount_usdc,amount_classification,raw_archive_key,
      market_key,token_id,tx_hash,side,shares,unit_price,outcome_index,event_slug,
      market_title,reported_usdc_size,source_row_index)
     select x.wallet,x.activity_key,x.occurred_at,x.kind,x.amount_usdc,x.amount_classification,
      x.raw_archive_key,x.market_key,x.token_id,x.tx_hash,x.side,x.shares,x.unit_price,
      x.outcome_index,x.event_slug,x.market_title,x.reported_usdc_size,x.source_row_index
     from jsonb_to_recordset(($1::text)::jsonb) as x(
      wallet text,activity_key text,occurred_at timestamptz,kind text,
      amount_usdc numeric,amount_classification text,raw_archive_key text,market_key text,token_id text,
      tx_hash text,side text,shares numeric,unit_price numeric,outcome_index smallint,event_slug text,
      market_title text,reported_usdc_size numeric,source_row_index integer)
     on conflict(wallet,activity_key) do nothing returning activity_key`,
      [JSON.stringify(normalized)]);
     inserted=rows.length;
    }
    const state=await tx.unsafe(`
     update pi.rn1_activity_import_state
     set next_cursor=$2,rows_seen=rows_seen+$3,rows_stored=rows_stored+$4,
      missing_required=missing_required+$5,pages_fetched=pages_fetched+1,
      status=case when $6::boolean then 'source_exhausted'
        when $7::boolean then 'pilot_complete' else 'collecting' end,
      lease_until=case when $6::boolean or $7::boolean then null else lease_until end,
      last_success_at=now(),last_error=null,updated_at=now()
     where wallet=$1 and next_cursor is not distinct from $8 and status='collecting'
     returning wallet`,
     [RN1,nextCursor,data.length,inserted,data.length-normalized.length,terminal,capReached,oldCursor]);
    if(!state.length)throw Error("Concurrent RN1 activity cursor changed");
   });
   seen+=data.length;stored+=inserted;pages++;cursor=nextCursor;
   if(terminal||capReached){status=terminal?"source_exhausted":"pilot_complete";break;}
  }
  if(status==="collecting")
   await db.unsafe("update pi.rn1_activity_import_state set lease_until=null,updated_at=now() where wallet=$1",[RN1]);
  await db.unsafe("update pi.ingestion_jobs set status='done',pages_fetched=$2,rows_fetched=$3,finished_at=now(),updated_at=now() where id=$1",[job[0].id,pages,seen]);
  return {status,pages,seen,stored,rejected};
 }catch(e){
  const message=e instanceof Error?e.message.slice(0,170):"unknown activity feed failure";
  await db.unsafe("update pi.rn1_activity_import_state set last_error=$2,lease_until=null,updated_at=now() where wallet=$1",[RN1,message]);
  await db.unsafe("update pi.ingestion_jobs set status='failed',error_message=$2,finished_at=now(),updated_at=now() where id=$1",[job[0].id,message]);
  console.error("rn1_v2_activity",message);
  return {status:"failed",pages,seen,stored,error:message};
 }
}


const RN1_FULL_BUCKET="pi-rn1-research-private";
type RN1ArchiveStream="trades_all"|"activity_all";
type MarketRollup={
 wallet:string;market_key:string;title:string;event_slug:string;fills:number;buy_fills:number;sell_fills:number;
 buy0_shares:number;buy1_shares:number;sell0_shares:number;sell1_shares:number;
 buy0_cost:number;buy1_cost:number;sell0_proceeds:number;sell1_proceeds:number;
 unknown_outcome_fills:number;min_trade_at:string;max_trade_at:string;
};
type ActivityRollup={
 wallet:string;market_key:string;kind:string;events:number;reported_usdc_size:number;amount_present:number;
 min_event_at:string;max_event_at:string;
};
function fullEnvelope(payload:unknown){
 const p=payload as any;
 if(!p||!Array.isArray(p.data)||p.data.length>1000||!p.pagination
  ||typeof p.pagination.has_more!=="boolean"
  ||(p.pagination.has_more&&p.data.length===0))return null;
 const next=p.pagination.next_cursor;
 if(next!==null&&next!==undefined&&(typeof next!=="string"||next.length>2048))return null;
 if(p.pagination.has_more&&(!next||typeof next!=="string"))return null;
 return {rows:p.data as any[],hasMore:p.pagination.has_more,nextCursor:typeof next==="string"&&next?next:null};
}
function recordRN1Aggregates(stream:RN1ArchiveStream,rows:any[],materializeMetrics:boolean){
 const markets=new Map<string,MarketRollup>();
 const activities=new Map<string,ActivityRollup>();
 let valid=0,invalid=0,minAt:string|null=null,maxAt:string|null=null;
 for(const raw of rows){
  const normalized=stream==="trades_all"?normalizeV2Trade(raw,RN1):normalizeActivity(raw,RN1);
  if(!normalized){invalid++;continue}
  valid++;
  const at=String(stream==="trades_all"?normalized.reported_at:normalized.occurred_at);
  minAt= !minAt||at<minAt?at:minAt;
  maxAt= !maxAt||at>maxAt?at:maxAt;
  if(!materializeMetrics)continue;
  if(stream==="trades_all"){
   const r=normalized,market_key=String(r.market_key);
   let m=markets.get(market_key);
   if(!m){
    m={wallet:RN1,market_key,title:String(r.market_title||""),event_slug:String(r.event_slug||""),
      fills:0,buy_fills:0,sell_fills:0,buy0_shares:0,buy1_shares:0,
      sell0_shares:0,sell1_shares:0,buy0_cost:0,buy1_cost:0,
      sell0_proceeds:0,sell1_proceeds:0,unknown_outcome_fills:0,min_trade_at:at,max_trade_at:at};
    markets.set(market_key,m);
   }
   m.fills++;
   if(at<m.min_trade_at)m.min_trade_at=at;
   if(at>m.max_trade_at)m.max_trade_at=at;
   if(!m.title&&r.market_title)m.title=String(r.market_title);
   if(!m.event_slug&&r.event_slug)m.event_slug=String(r.event_slug);
   const shares=Number(r.shares),notional=Number(r.observed_notional_usdc),index=r.outcome_index;
   if(r.side==="BUY"){m.buy_fills++;
    if(index===0){m.buy0_shares+=shares;m.buy0_cost+=notional}
    else if(index===1){m.buy1_shares+=shares;m.buy1_cost+=notional}
    else m.unknown_outcome_fills++;
   }else{m.sell_fills++;
    if(index===0){m.sell0_shares+=shares;m.sell0_proceeds+=notional}
    else if(index===1){m.sell1_shares+=shares;m.sell1_proceeds+=notional}
    else m.unknown_outcome_fills++;
   }
  }else{
   const market_key=String(normalized.market_key||"__global__");
   const kind=String(normalized.kind);
   const key=market_key+"|"+kind;
   let a=activities.get(key);
   if(!a){a={wallet:RN1,market_key,kind,events:0,reported_usdc_size:0,
       amount_present:0,min_event_at:at,max_event_at:at};activities.set(key,a)}
   a.events++;
   if(at<a.min_event_at)a.min_event_at=at;
   if(at>a.max_event_at)a.max_event_at=at;
   if(normalized.reported_usdc_size!==null && normalized.reported_usdc_size!==undefined){
    a.reported_usdc_size+=Number(normalized.reported_usdc_size);a.amount_present++;
   }
  }
 }
 return {valid,invalid,minAt,maxAt,markets:[...markets.values()],activities:[...activities.values()]};
}
async function gzipRN1Data(input:string):Promise<Uint8Array>{
 const body=new Blob([input]).stream().pipeThrough(new CompressionStream("gzip"));
 return new Uint8Array(await new Response(body).arrayBuffer());
}
async function uploadRN1Archive(key:string,payload:Uint8Array){
 const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
 const url=Deno.env.get("SUPABASE_URL")||"";
 if(!service||!/^https:\/\/[^/]+\.supabase\.co$/.test(url))throw Error("Private Storage environment missing");
 const response=await fetch(url+"/storage/v1/object/"+RN1_FULL_BUCKET+"/"+key,{
  method:"POST",headers:{"Authorization":"Bearer "+service,"apikey":service,
   "Content-Type":"application/gzip","x-upsert":"true","cache-control":"3600"},
  body:payload as BodyInit,signal:AbortSignal.timeout(25000)});
 if(!response.ok)throw Error("RN1 private archive upload HTTP "+response.status+
  " "+(await response.text()).slice(0,130));
}
async function runRN1FullStream(stream:RN1ArchiveStream){
 const state=await db.unsafe(`
 update pi.rn1_full_streams set lease_until=now()+interval '90 seconds',updated_at=now()
 where stream=$1 and status='collecting'
 and (lease_until is null or lease_until<now())
 returning stream,source_path,next_cursor,pages_fetched,rows_seen,raw_gzip_bytes,max_raw_bytes,max_db_bytes`,[stream]);
 if(!state.length)return {stream,status:"idle_or_paused"};
 const job=state[0],status={stream,pages:0,rows:0,valid:0,invalid:0};
 const limits=await db.unsafe(`select pg_database_size(current_database())::bigint db_bytes,
    coalesce((select sum(raw_gzip_bytes) from pi.rn1_full_streams),0)::bigint all_raw_bytes`);
 if(Number(limits[0].all_raw_bytes)>=Number(job.max_raw_bytes)){
  await db.unsafe(`update pi.rn1_full_streams set status='paused_quota',lease_until=null,
   last_error='Collection paused before shared DB/storage safety budget',
   updated_at=now() where stream=$1`,[stream]);
  return {...status,status:"paused_quota"};
 }
 let cursor=job.next_cursor as string|null;
 try{
  for(let j=0;j<2;j++){
   const params:Record<string,string>=stream==="trades_all"
    ?{user:RN1,start:"1",limit:"1000",taker_only:"false"}
    :{user:RN1,start:"1",limit:"1000"};
   if(cursor)params.cursor=cursor;
   const response=await get(String(job.source_path),params);
   const envelope=fullEnvelope(response);
   if(!envelope)throw Error("Unexpected full-history V2 envelope");
   if(envelope.hasMore&&envelope.nextCursor===cursor)throw Error("Source cursor did not advance");
   const oldCursor=cursor;
   const pageNo=Number(job.pages_fetched)+status.pages+1;
   const materializeMetrics=Number(limits[0].db_bytes)<Number(job.max_db_bytes);
   const rollup=recordRN1Aggregates(stream,envelope.rows,materializeMetrics);
   const raw=JSON.stringify({source_response:response,request:params});
   const digest=await sha256(raw);
   const key=stream+"/page-"+String(pageNo).padStart(8,"0")+"-"+digest.slice(0,16)+".json.gz";
   const payload=await gzipRN1Data(raw);
   if(payload.byteLength>20000000)throw Error("Compressed page exceeded bucket file cap");
   if(Number(limits[0].all_raw_bytes)+payload.byteLength
      >Number(job.max_raw_bytes)){
    await db.unsafe(`update pi.rn1_full_streams set status='paused_quota',
      lease_until=null,last_error='Private source archives reached safety budget',
      updated_at=now() where stream=$1`,[stream]);
    return {...status,status:"paused_quota"};
   }
   await uploadRN1Archive(key,payload);
   const finished=!envelope.hasMore;
   await db.begin(async tx=>{
    const a=await tx.unsafe(`
     insert into pi.rn1_full_archive_pages
      (stream,page_no,sha256,storage_key,cursor_in,cursor_out,row_count,valid_count,invalid_count,
       compressed_bytes,min_reported_at,max_reported_at)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict(stream,page_no) do nothing returning page_no`,
     [stream,pageNo,digest,key,oldCursor,envelope.nextCursor,envelope.rows.length,rollup.valid,
      rollup.invalid,payload.byteLength,rollup.minAt,rollup.maxAt]);
    if(!a.length)throw Error("Full history archive page conflict");
    if(rollup.markets.length){
     await tx.unsafe(`
      insert into pi.rn1_full_market_metrics(
       wallet,market_key,title,event_slug,fills,buy_fills,sell_fills,
       buy0_shares,buy1_shares,sell0_shares,sell1_shares,
       buy0_cost,buy1_cost,sell0_proceeds,sell1_proceeds,unknown_outcome_fills,min_trade_at,max_trade_at)
      select x.wallet,x.market_key,x.title,x.event_slug,x.fills,x.buy_fills,x.sell_fills,
       x.buy0_shares,x.buy1_shares,x.sell0_shares,x.sell1_shares,
       x.buy0_cost,x.buy1_cost,x.sell0_proceeds,x.sell1_proceeds,x.unknown_outcome_fills,
       x.min_trade_at,x.max_trade_at
      from jsonb_to_recordset(($1::text)::jsonb) as x(
       wallet text,market_key text,title text,event_slug text,fills bigint,
       buy_fills bigint,sell_fills bigint,buy0_shares numeric,buy1_shares numeric,
       sell0_shares numeric,sell1_shares numeric,buy0_cost numeric,buy1_cost numeric,
       sell0_proceeds numeric,sell1_proceeds numeric,unknown_outcome_fills bigint,
       min_trade_at timestamptz,max_trade_at timestamptz)
      on conflict(wallet,market_key) do update set
       fills=pi.rn1_full_market_metrics.fills+excluded.fills,
       buy_fills=pi.rn1_full_market_metrics.buy_fills+excluded.buy_fills,
       sell_fills=pi.rn1_full_market_metrics.sell_fills+excluded.sell_fills,
       buy0_shares=pi.rn1_full_market_metrics.buy0_shares+excluded.buy0_shares,
       buy1_shares=pi.rn1_full_market_metrics.buy1_shares+excluded.buy1_shares,
       sell0_shares=pi.rn1_full_market_metrics.sell0_shares+excluded.sell0_shares,
       sell1_shares=pi.rn1_full_market_metrics.sell1_shares+excluded.sell1_shares,
       buy0_cost=pi.rn1_full_market_metrics.buy0_cost+excluded.buy0_cost,
       buy1_cost=pi.rn1_full_market_metrics.buy1_cost+excluded.buy1_cost,
       sell0_proceeds=pi.rn1_full_market_metrics.sell0_proceeds+excluded.sell0_proceeds,
       sell1_proceeds=pi.rn1_full_market_metrics.sell1_proceeds+excluded.sell1_proceeds,
       unknown_outcome_fills=pi.rn1_full_market_metrics.unknown_outcome_fills+excluded.unknown_outcome_fills,
       min_trade_at=least(pi.rn1_full_market_metrics.min_trade_at,excluded.min_trade_at),
       max_trade_at=greatest(pi.rn1_full_market_metrics.max_trade_at,excluded.max_trade_at),
       title=coalesce(nullif(pi.rn1_full_market_metrics.title,''),excluded.title),
       event_slug=coalesce(nullif(pi.rn1_full_market_metrics.event_slug,''),excluded.event_slug),
       updated_at=now()`,[JSON.stringify(rollup.markets)]);
    }
    if(rollup.activities.length){
     await tx.unsafe(`
      insert into pi.rn1_full_activity_metrics(
       wallet,market_key,kind,events,reported_usdc_size,amount_present,min_event_at,max_event_at)
      select x.wallet,x.market_key,x.kind,x.events,x.reported_usdc_size,x.amount_present,
       x.min_event_at,x.max_event_at
      from jsonb_to_recordset(($1::text)::jsonb) as x(
       wallet text,market_key text,kind text,events bigint,reported_usdc_size numeric,
       amount_present bigint,min_event_at timestamptz,max_event_at timestamptz)
      on conflict(wallet,market_key,kind) do update set
       events=pi.rn1_full_activity_metrics.events+excluded.events,
       reported_usdc_size=pi.rn1_full_activity_metrics.reported_usdc_size+excluded.reported_usdc_size,
       amount_present=pi.rn1_full_activity_metrics.amount_present+excluded.amount_present,
       min_event_at=least(pi.rn1_full_activity_metrics.min_event_at,excluded.min_event_at),
       max_event_at=greatest(pi.rn1_full_activity_metrics.max_event_at,excluded.max_event_at)`,
       [JSON.stringify(rollup.activities)]);
    }
    const advanced=await tx.unsafe(`
     update pi.rn1_full_streams
     set pages_fetched=pages_fetched+1,rows_seen=rows_seen+$3,
      rows_valid=rows_valid+$4,rows_invalid=rows_invalid+$5,raw_gzip_bytes=raw_gzip_bytes+$6,
      next_cursor=$2,first_seen_at=least(first_seen_at,$7::timestamptz),
      last_seen_at=greatest(last_seen_at,$8::timestamptz),
      last_success_at=now(),updated_at=now(),last_error=null,
      status=case when $9::boolean then 'source_exhausted' else 'collecting' end,
      source_exhausted_at=case when $9::boolean then now() else source_exhausted_at end,
      lease_until=case when $9::boolean then null else lease_until end,
      metrics_rows=metrics_rows+$12,
      metrics_paused_at=case when $13::boolean then coalesce(metrics_paused_at,now()) else metrics_paused_at end
     where stream=$1 and pages_fetched=$10 and next_cursor is not distinct from $11
       and status='collecting' returning stream`,
     [stream,envelope.nextCursor,envelope.rows.length,rollup.valid,rollup.invalid,
      payload.byteLength,rollup.minAt,rollup.maxAt,finished,pageNo-1,oldCursor,
      materializeMetrics?rollup.valid:0,!materializeMetrics]);
    if(!advanced.length)throw Error("Concurrent full archive cursor update");
   });
   status.pages++;status.rows+=envelope.rows.length;status.valid+=rollup.valid;status.invalid+=rollup.invalid;
   cursor=envelope.nextCursor;
   if(finished){
    return {...status,status:"source_exhausted"};
   }
  }
  await db.unsafe("update pi.rn1_full_streams set lease_until=null where stream=$1 and status='collecting'",[stream]);
  return {...status,status:"collecting"};
 }catch(e){
  const message=e instanceof Error?e.message.slice(0,190):"Full history worker failed";
  console.error("rn1_full_archive",stream,message);
  await db.unsafe(`update pi.rn1_full_streams set lease_until=null,last_error=$2,updated_at=now()
   where stream=$1`,[stream,message]);
  return {...status,status:"failed",error:message};
 }
}

async function scheduledRN1Trades(){
 // Bounded 4,000-row study: not a complete historical backfill. No orders and no claims of maker identity.
 await db.unsafe("insert into pi.rn1_trade_import_state(wallet) values($1) on conflict do nothing",[RN1]);
 const claim=await db.unsafe(`
  update pi.rn1_trade_import_state set lease_until=now()+interval '110 seconds',updated_at=now()
  where wallet=$1 and status='collecting'
    and (lease_until is null or lease_until<now())
  returning next_cursor,rows_seen,sample_limit,pages_fetched`,[RN1]);
 if(!claim.length)return {status:"idle_or_leased"};
 const job=await db.unsafe("insert into pi.ingestion_jobs(wallet,stream,status,started_at) values($1,'rn1_v2_trades','running',now()) returning id",[RN1]);
 let pages=0,seen=0,stored=0,invalid=0,status="collecting",cursor=claim[0].next_cursor as string|null;
 try{
  for(let j=0;j<2;j++){
   const params:Record<string,string>={user:RN1,limit:"200",start:"1"};
   if(cursor)params.cursor=cursor;
   const sourcePayload=await get("/v2/trades",params);
   const response=pageEnvelope(sourcePayload);
   if(!response)throw Error("Unexpected V2 trades envelope");
   const {data,hasMore,nextCursor}=response;
   if(hasMore&&nextCursor===cursor)throw Error("V2 cursor failed to advance");
   if(seen+Number(claim[0].rows_seen)+data.length>Number(claim[0].sample_limit))
     throw Error("Pilot page exceeds configured cap");
   // Archive before any aggregation. The raw envelope and row order are preserved for forensic audit.
   const raw={source_response:sourcePayload,request:{user:RN1,start:1,limit:200,requested_cursor:cursor}};
   const pageSHA=await sha256(JSON.stringify(raw));
   const normalized:Record<string,unknown>[]=[];
   for(let i=0;i<data.length;i++){
    const item=normalizeV2Trade(data[i]);
    if(!item){invalid++;continue;}
    normalized.push({...item,trade_key:"v2:"+await sha256(pageSHA+":"+i),source_row_index:i,raw_archive_key:"rn1-v2:"+pageSHA});
   }
   // Raw page, normalized trades, and cursor advancement share ONE DB transaction.
   const old=cursor,nowCursor=nextCursor,terminal=!hasMore,capReached=(Number(claim[0].rows_seen)+seen+data.length)>=Number(claim[0].sample_limit);
   let inserted=0;
   await db.begin(async tx=>{
    const archive=await tx.unsafe(`
      insert into pi.rn1_trade_pages(page_sha,wallet,requested_cursor,returned_cursor,row_count,
       first_trade_ts,last_trade_ts,raw_payload)
      values($1,$2,$3,$4,$5,$6,$7,($8::text)::jsonb)
      on conflict(page_sha) do nothing returning page_sha`,
      [pageSHA,RN1,old,nowCursor,data.length,
       data.length?new Date(Math.min(...data.map((a:any)=>Number(a.timestamp)))*1000).toISOString():null,
       data.length?new Date(Math.max(...data.map((a:any)=>Number(a.timestamp)))*1000).toISOString():null,
       JSON.stringify(raw)]);
    if(!archive.length)throw Error("Repeated raw page; cursor not advancing");
    if(normalized.length){
     const rows=await tx.unsafe(`
       insert into pi.trades
        (wallet,trade_key,reported_at,first_observed_at,market_key,token_id,tx_hash,side,price,shares,
         observed_notional_usdc,raw_archive_key,outcome_index,outcome_label,market_slug,event_slug,source_row_index,market_title)
       select x.wallet,x.trade_key,x.reported_at,now(),x.market_key,x.token_id,x.tx_hash,x.side,x.price,x.shares,
         x.observed_notional_usdc,x.raw_archive_key,x.outcome_index,x.outcome_label,x.market_slug,x.event_slug,x.source_row_index,x.market_title
       from jsonb_to_recordset(($1::text)::jsonb) as x(
        wallet text,trade_key text,reported_at timestamptz,market_key text,token_id text,tx_hash text,
        side text,price numeric,shares numeric,observed_notional_usdc numeric,raw_archive_key text,
        outcome_index smallint,outcome_label text,market_slug text,event_slug text,source_row_index integer,market_title text)
       on conflict(wallet,trade_key) do nothing returning trade_key`,[JSON.stringify(normalized)]);
     inserted=rows.length;
    }
    const state=await tx.unsafe(`
      update pi.rn1_trade_import_state
      set next_cursor=$2,rows_seen=rows_seen+$3,rows_stored=rows_stored+$4,
        missing_required=missing_required+$5,pages_fetched=pages_fetched+1,
        status=case when $6::boolean then 'source_exhausted' when $7::boolean then 'pilot_complete' else 'collecting' end,
        lease_until=case when $6::boolean or $7::boolean then null else lease_until end,
        last_success_at=now(),last_error=null,updated_at=now()
      where wallet=$1 and next_cursor is not distinct from $8 and status='collecting' returning wallet`,
      [RN1,nowCursor,data.length,inserted,normalized.length?data.length-normalized.length:data.length,terminal,capReached,old]);
    if(!state.length)throw Error("Concurrent RN1 cursor changed");
   });
   pages++;seen+=data.length;stored+=inserted;cursor=nextCursor;
   if(terminal||capReached){status=terminal?"source_exhausted":"pilot_complete";break;}
  }
  if(status==="collecting")await db.unsafe("update pi.rn1_trade_import_state set lease_until=null,updated_at=now() where wallet=$1",[RN1]);
  await db.unsafe("update pi.ingestion_jobs set status='done',pages_fetched=$2,rows_fetched=$3,finished_at=now(),updated_at=now() where id=$1",[job[0].id,pages,seen]);
  return {status,pages,seen,stored,invalid};
 }catch(e){
  const message=e instanceof Error?e.message.slice(0,170):"unknown V2 feed failure";
  await db.unsafe("update pi.rn1_trade_import_state set last_error=$2,lease_until=null,updated_at=now() where wallet=$1",[RN1,message]);
  await db.unsafe("update pi.ingestion_jobs set status='failed',error_message=$2,finished_at=now(),updated_at=now() where id=$1",[job[0].id,message]);
  console.error("rn1_v2_trades",message);
  return {status:"failed",pages,seen,stored,error:message};
 }
}

async function schedulerAllowed(req: Request): Promise<boolean> {
  const token = req.headers.get("x-pi-scheduler-token") ?? "";
  if (!/^[0-9a-f]{64}$/.test(token)) return false;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const hashed = [...digest].map((x) => x.toString(16).padStart(2,"0")).join("");
  const r = await db.unsafe("select 1 from pi.scheduler_auth where single_row_id=1 and token_sha256=$1", [hashed]);
  return r.length===1;
}
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (Number(req.headers.get("content-length") ?? 0)>5000) return json({error:"Payload too large"},413);
  try {
    const body = await req.json();
    if (body?.action === "rn1_activity_scheduled") {
      if (!await schedulerAllowed(req)) return json({error:"Forbidden"},403);
      return json(await scheduledRN1Activity());
    }
    if (body?.action === "rn1_full_archive_scheduled") {
      if (!await schedulerAllowed(req)) return json({error:"Forbidden"},403);
      const stream=String(body.stream||"");
      if(stream!=="trades_all"&&stream!=="activity_all")return json({error:"Invalid stream"},400);
      return json(await runRN1FullStream(stream));
    }
    if (body?.action === "rn1_trades_scheduled") {
      if (!await schedulerAllowed(req)) return json({error:"Forbidden"},403);
      return json(await scheduledRN1Trades());
    }
    if (body?.action === "arb_temporal_scheduled") {
      if (!await schedulerAllowed(req)) return json({error:"Forbidden"},403);
      return json(await scheduledTemporal());
    }
    if (body?.action === "roi_scheduled") {
      if (!await schedulerAllowed(req)) return json({error:"Forbidden"},403);
      return json(await syncQueuedRoi());
    }
    if (body?.action === "roi_manual") {
      if (!await schedulerAllowed(req)) return json({error:"Forbidden"},403);
      const wallet=String(body.wallet??"").toLowerCase(),pages=Number(body.pages??1);
      if(!ADDRESS.test(wallet)||!Number.isInteger(pages)||pages<1||pages>4)
        return json({error:"Invalid wallet or pages"},400);
      return json(await refreshClosedPositions(wallet,pages));
    }
    if (body?.action === "scheduled") {
      if (!await schedulerAllowed(req)) return json({error:"Forbidden"},403);
      const requested = Number(body.limit ?? 5);
      if (!Number.isInteger(requested) || requested<1 || requested>5) return json({error:"Invalid batch size"},400);
      return json(await scheduled(requested));
    }
    // Non-scheduler administration remains restricted to the service-role secret.
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!key || req.headers.get("authorization") !== "Bearer " + key)
      return json({ error: "Forbidden" }, 403);
    if (body.action === "discover") {
      const limit = Number(body.limit ?? 20);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) return json({ error: "limit 1..50" }, 400);
      return json(await discover(limit));
    }
    if (body.action === "refresh") {
      const wallets: string[] = Array.isArray(body.wallets) ?
        Array.from(new Set<string>((body.wallets as unknown[]).map((w) => String(w).toLowerCase()))) : [];
      if (!wallets.length || wallets.length > 10 || wallets.some((w) => !ADDRESS.test(w)))
        return json({ error: "Provide 1..10 valid wallets" }, 400);
      const results = [];
      for (const w of wallets) {
        try { results.push(await refresh(w)); }
        catch (err) { results.push({ wallet: w, error: String(err).slice(0, 120) }); }
      }
      return json({ results });
    }
    return json({ error: "Unsupported action" }, 400);
  } catch (err) {
    console.error(err instanceof Error ? err.message : "ingest error");
    return json({ error: "Ingestion failed" }, 500);
  }
});
