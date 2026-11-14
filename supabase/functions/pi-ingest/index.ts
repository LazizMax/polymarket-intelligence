// Bounded Polymarket ingestion. Admin API needs service role; scheduled route requires a private Vault-backed token.
// Backend writes private pi schema, with no credentials exposed in the browser.
import postgres from "npm:postgres@3.4.3";

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
  const previous = await db.unsafe("select exists(select 1 from pi.wallet_pnl_daily where wallet=$1) as has_data", [wallet]);
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
