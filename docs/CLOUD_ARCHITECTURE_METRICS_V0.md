# Cloud analytics V0 — architecture, storage, ROI/drawdown contract

**Status 2026-11-14 (cloud beta):** A private `pi` schema is deployed inside the existing Fit Tracker Supabase project with 100 Polymarket wallets and 46,673 daily PnL observations. A 3-screen hosted dashboard at https://bxfvgywfiifnsbjgudzj.supabase.co/functions/v1/pi-dashboard requires a valid Supabase Auth session and a separate `pi.dashboard_access` allowlist. A Vault-authenticated pg_cron job refreshes 5 wallets every 15 minutes; the first scheduled 5-wallet run was successful on 2026-11-14 at 23:30 UTC. One initial manual test failed and remains logged. Historical ROI on invested capital and copy-trading edge have NOT been validated. Windows V2.2 remains unchanged.

## Goal

Replace heavy local reads with a fast web dashboard based on PostgreSQL summaries, while a separate Python worker imports Polymarket history into a dedicated database. Preserve original observations for auditability. Do not publish a "verified" ROI unless its basis is supported.

### Services

- **Ingestion worker:** runs independently of the website; bounded parallel wallet fetches, cursor checkpoints, incremental UPSERTs, 429 backoff, deterministic fill keys, retryable errors and job telemetry. Initial backfill is separate from recurring refresh.
- **Supabase PostgreSQL:** normalized wallets, events, markets, trades, position snapshots, economic activities, daily observed PnL and audited portfolio equity. Precomputed wallet summary table refreshed after ingestion.
- **Object storage (private):** compressed NDJSON/Parquet batches of raw API replies, archive checksum in PostgreSQL. Do not duplicate megabytes of raw JSON per trade.
- **Web UI:** lightweight self-contained HTML/TypeScript served by a Supabase Edge Function, with server-side pagination and three areas: Rankings, Wallet, and Data quality. JWTs are verified against Supabase Auth and then checked against an explicit private user allowlist; no service-role secret or DB password is sent to the browser.
- **Hosting:** Supabase Edge Functions host the dashboard and a separate ingestion endpoint. The cron trigger uses pg_cron + pg_net + a secret stored in Supabase Vault. No additional hosting service or subscription was provisioned.

### Database security

SQL draft at \`sql/001_cloud_private_schema.sql\` creates a private \`pi\` schema with RLS on all 12 tables, no public or browser role access. A server-side backend accesses database with a secret kept in deployment environment variables. Browser identity/policies require deliberate authorization design before direct API exposure. For the initial pilot, the user approved an isolated `pi` schema inside Fit Tracker. This is an infrastructure-sharing arrangement only; no Fit Tracker business data is accessed or mixed. A dedicated project may be appropriate once actual storage and CPU use are known.

## Storage estimates (planning only, benchmark after 10,000 real rows)

These are deliberately broad; actual size depends on fill payload, varchar lengths, indexes, duplicates, VACUUM, time-series frequency and archived data.

| Normalized trades | Planning estimate (Postgres data + indexes) |
|---:|---:|
| 100,000 | ~30–150 MB |
| 1,000,000 | ~0.3–1.5 GB |
| 10,000,000 | ~3–15 GB |

Add wallet snapshots, daily points, materialized scores and market metadata on top. Raw NDJSON/Parquet archives should be kept in compressed object storage and costed separately. Before paying for scaling, import a 10,000-fill sample and measure \`pg_total_relation_size\` table-by-table.

Supabase pricing verified 2026-11-14: Free includes 500 MB database quota, Pro starts at $25 per month with more disk and possible overage. Account currently has two separate active Supabase projects; do not create a billable third one without selecting an organization and cost approval.

## Financial metric contracts

1. **Historical ROI on stakes (closed positions):** net realized position profit / verified total historical entry costs on those positions. Requires lifetime cost and all legs; partial redemptions, fees and incomplete snapshots invalidate. NOT return on capital.
2. **Observed cumulative economic PnL:** the difference between two daily PnL snapshots. Missing dates yield an incomplete curve and only an observed lower bound on drawdown in USDC.
3. **Observed PnL drawdown (USDC):** at each observed date, running peak of cumulative PnL minus current cumulative PnL. Drawdown cannot be expressed as a wallet capital percentage using this series alone. The \`PnL change / max observed PnL DD\` ratio is a descriptive *recovery factor*, not ROI/DD.
4. **Portfolio equity drawdown (%):** requires daily portfolio cash + all held positions marked to market and reconciled external flows. Build a flow-adjusted index, max peak-to-trough fall and ratio \`flow-adjusted return / max DD\`, with **both derived from the same equity curve**.
5. **Return on capital:** when daily external cash flows are assumed to happen at end of day, the adjusted return is only **indicative**. Intraday cash-flow timing and completeness are required before labelling it audited time-weighted return; deposits and withdrawals must never be counted as profit.
6. **Linearity:** R² of cumulative PnL or indexed equity versus elapsed days; shown together with slope and ROI, never as a standalone badge proving skill. A smooth downward trend also has a high R². Better add fraction of positive weeks and drawdown duration later.
7. **Selection bias:** neither a smooth curve nor a large ROI constitutes evidence that copying that wallet will work; only a predeclared, out-of-sample copy simulation at observable prices/costs can test that.

The Python foundation `cloud/performance_analytics.py` implements separate PnL and equity diagnostics. Its output is exploratory; the verified equity timeline is not yet available from the current collector.

## First working cloud milestone

- Use the existing Fit Tracker Supabase project as a temporary host (approved, done); revisit isolation after usage measurements.
- Apply and test the private schema, security and indexes.
- Import **100 wallets maximum initially** from the existing SQLite database (not blindly all history), deduplicate, record byte size, import latency, completeness and accounting differences.
- Compute daily source PnL and wallet-level metrics in a background job; do not calculate tens of millions of rows on dashboard page load.
- Deliver an online **wallet detail** showing PnL curve, observed DD $ and missing-data coverage; only show DD% and ROI/DD when equity history passes the integrity gate.
- Deliver leaderboard with backend pagination/filtering, latest metrics cache, and source freshness.
- Measure actual p50/p95 response time and actual database usage. Aim at sub-500 ms cached result retrieval as a target, not a promise.
- Only after this works, add sector-level stratification, out-of-sample cohorts, and prospective copy trading validation.

## SQL read performance

The private schema includes \`(wallet, reported_at desc)\` on trades, \`(wallet, day desc)\` on PnL/equity and cached metrics by day/ROI. Frontend asks precomputed metrics, never a raw fill-by-fill scan. Use explicit pagination and restrict graph series to bounded date windows.

## Migration safety

Existing \`%LOCALAPPDATA%\PolymarketIntelligence\` remains source-of-truth until cloud roundtrip verification. Upload batches are idempotent on \`(wallet,trade_key)\`. A dual-read comparison of total wallets/fills/positions and the latest PnL validates migration before switching the UI. No destructive migration of the user's other Supabase projects.


## Deployed backend scope and safety

- Supabase SQL migration: `sql/001_cloud_private_schema.sql` (applied) and `sql/002_pi_ingestion_wallet_idx.sql` (applied).
- Edge Function: `pi-ingest` is deployed with JWT verification and service-role-only checks. Only a backend admin can call `POST /functions/v1/pi-ingest` with `{"action":"discover","limit":20}` or `{"action":"refresh","wallets":["0x..."]}`. **Do not put a service-role key in a webpage, repo, or mobile app.**
- The discovery step fetches current leaderboards from Polymarket Data API v2, which are subject to survivorship/leaderboard selection bias.
- The refresh step currently stores only daily `user-pnl` source points (with `completeness='partial'`) and observed USD drawdown. No equity ROI is calculated. This is a staged, not complete, importer; normalized trades, market metadata, wallet activities, cron, and full accounting reconciliation remain to implement.
- The private online dashboard is deployed and protected by an Auth user allowlist; only public login HTML is anonymous. A 5-wallet/15-minute pg_cron task is active and its first scheduled execution successfully updated 5 wallets. The ingestion endpoint uses application-layer checks: exact service role for administration, or a Vault-token SHA-256 match for the narrow scheduled action (gateway JWT verification is disabled for this endpoint).
- Post-migration verification: 12 tables, 12 with RLS, no schema USAGE privilege for `anon` or `authenticated`, trusted `service_role` permitted. One preexisting Fit Tracker row remained present.
- Security advisor "RLS enabled without policies" on private `pi` tables is intentional: deny all browser users. Performance advisor found one missing foreign-key index, fixed in migration 002.


**Updated pilot results:** [100-wallet import and tested online notebook](SUPABASE_PILOT_100_WALLETS.md). Temporary SQL `http` extension used for the one-time backfill has been removed after ingestion; ongoing ingestion should use the secured Edge collector, not synchronous HTTP inside PostgreSQL.


See [Cloud operations and security runbook](CLOUD_RUNBOOK_V1.md) for current deployment, authentication, monitoring, and pausing the scheduled job.
