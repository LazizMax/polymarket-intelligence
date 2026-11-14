-- Design draft for a dedicated Polymarket Intelligence Supabase project.
-- NOT APPLIED to LGS Poker or Fit Tracker. Run only after project choice/cost approval.
-- Private schema; no browser-direct REST grants, no secret keys in frontend.

begin;

create schema if not exists pi;
revoke all on schema pi from public;
revoke all on schema pi from anon, authenticated;
alter default privileges in schema pi revoke all on tables from public, anon, authenticated;
alter default privileges in schema pi revoke all on sequences from public, anon, authenticated;

create table if not exists pi.wallets (
  wallet text primary key check (wallet ~ '^0x[0-9a-f]{40}$'),
  display_name text,
  discovered_at timestamptz not null default now(),
  last_seen_at timestamptz,
  tags text[] not null default '{}',
  data_quality text not null default 'unverified'
    check (data_quality in ('unverified','partial','reconciled')),
  audit_note text
);

create table if not exists pi.events (
  event_key text primary key,
  title text,
  sector text,
  category_provenance text not null default 'unclassified'
    check(category_provenance in ('unclassified','heuristic','gamma','manual')),
  resolution_at timestamptz,
  last_updated_at timestamptz not null default now()
);

create table if not exists pi.markets (
  market_key text primary key,
  event_key text references pi.events(event_key),
  question text,
  resolved boolean,
  resolved_at timestamptz,
  last_updated_at timestamptz not null default now()
);
create index if not exists idx_pi_markets_event on pi.markets(event_key);

-- Individual fills: no raw_json duplicated on every row; store archive key in object storage.
create table if not exists pi.trades (
  wallet text not null references pi.wallets(wallet),
  trade_key text not null,
  reported_at timestamptz not null,
  first_observed_at timestamptz,
  event_key text,
  market_key text,
  token_id text,
  tx_hash text,
  side text not null check (side in ('BUY','SELL')),
  price numeric(16,10) not null check (price >= 0 and price <= 1),
  shares numeric(38,18) not null check (shares >= 0),
  observed_notional_usdc numeric(28,10),
  raw_archive_key text,
  collected_at timestamptz not null default now(),
  primary key (wallet, trade_key)
);
create index if not exists idx_pi_trades_wallet_time
  on pi.trades(wallet, reported_at desc);
create index if not exists idx_pi_trades_event_time
  on pi.trades(event_key, reported_at desc) where event_key is not null;
create index if not exists idx_pi_trades_market_time
  on pi.trades(market_key, reported_at desc) where market_key is not null;

-- Snapshot is not a wallet lifetime ledger; retained for provenance and reconciliation.
create table if not exists pi.position_snapshots (
  wallet text not null references pi.wallets(wallet),
  snapshot_at timestamptz not null,
  position_key text not null,
  state text not null check (state in ('OPEN','CLOSED','REDEEMABLE','REDEEMABLE_LOST','UNKNOWN')),
  token_id text,
  event_key text,
  market_key text,
  shares numeric(38,18),
  reported_cost_usdc numeric(28,10),
  reported_value_usdc numeric(28,10),
  realized_pnl_usdc numeric(28,10),
  unrealized_pnl_usdc numeric(28,10),
  pnl_scope text not null default 'unknown',
  raw_archive_key text,
  primary key (wallet, snapshot_at, position_key)
);
create index if not exists idx_pi_positions_wallet_time
  on pi.position_snapshots(wallet, snapshot_at desc);

create table if not exists pi.wallet_activity (
  wallet text not null references pi.wallets(wallet),
  activity_key text not null,
  occurred_at timestamptz not null,
  kind text not null,
  amount_usdc numeric(28,10),
  amount_classification text not null default 'unknown'
    check(amount_classification in ('unknown','cash_flow','reward','trade','other')),
  raw_archive_key text,
  primary key(wallet, activity_key)
);
create index if not exists idx_pi_activity_wallet_time
  on pi.wallet_activity(wallet, occurred_at desc);

-- Official snapshots/observations, NOT necessarily a reconstructed net equity curve.
create table if not exists pi.wallet_pnl_daily (
  wallet text not null references pi.wallets(wallet),
  day date not null,
  source text not null,
  realized_pnl_usdc numeric(28,10),
  economic_pnl_usdc numeric(28,10),
  position_pnl_usdc numeric(28,10),
  collected_at timestamptz not null default now(),
  completeness text not null default 'unverified'
    check(completeness in ('unverified','partial','complete')),
  primary key (wallet, day, source)
);
create index if not exists idx_pi_pnl_wallet_day on pi.wallet_pnl_daily(wallet, day desc);

-- Populate ONLY once cash + mark-to-market portfolio value and external flows are audited.
-- Equity already includes all assets/cash: do not add any separate realized PnL again.
create table if not exists pi.wallet_equity_daily (
  wallet text not null references pi.wallets(wallet),
  day date not null,
  equity_usdc numeric(28,10) not null check (equity_usdc >= 0),
  external_flow_usdc numeric(28,10),
  complete_market_valuation boolean not null default false,
  external_flows_reconciled boolean not null default false,
  snapshot_provenance text not null default 'unverified',
  calculated_at timestamptz not null default now(),
  primary key (wallet, day)
);
create index if not exists idx_pi_equity_wallet_day on pi.wallet_equity_daily(wallet, day desc);

-- Cache for ultra-fast web tables; background jobs own writes.
create table if not exists pi.wallet_metrics_daily (
  wallet text not null references pi.wallets(wallet),
  day date not null,
  roi_on_closed_stakes_pct numeric(18,6),
  flow_adjusted_return_pct numeric(18,6),
  max_observed_pnl_drawdown_usdc numeric(28,10),
  max_equity_drawdown_pct numeric(18,6),
  return_to_drawdown_ratio numeric(18,6),
  positive_daily_change_pct numeric(18,6),
  pnl_linearity_r2 numeric(12,8),
  unique_events integer check (unique_events is null or unique_events >= 0),
  observation_days integer check (observation_days is null or observation_days >= 0),
  quality_status text not null default 'unverified',
  incomplete_reason text,
  computed_at timestamptz not null default now(),
  primary key (wallet, day)
);
create index if not exists idx_pi_metrics_latest on pi.wallet_metrics_daily(day desc);
create index if not exists idx_pi_metrics_roi on pi.wallet_metrics_daily(day desc, roi_on_closed_stakes_pct desc)
  where roi_on_closed_stakes_pct is not null;

create table if not exists pi.ingestion_jobs (
  id bigint generated always as identity primary key,
  wallet text references pi.wallets(wallet),
  stream text not null,
  status text not null default 'queued'
    check(status in ('queued','running','done','partial','failed','cancelled')),
  started_at timestamptz,
  finished_at timestamptz,
  pages_fetched integer not null default 0,
  rows_fetched integer not null default 0,
  error_message text,
  updated_at timestamptz not null default now()
);
create index if not exists idx_pi_ingestion_status
  on pi.ingestion_jobs(status, updated_at desc);

create table if not exists pi.ingestion_cursors (
  wallet text not null references pi.wallets(wallet),
  stream text not null,
  next_cursor text,
  last_seen_at timestamptz,
  historic_backfill_exhausted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key(wallet, stream)
);

create table if not exists pi.raw_archives (
  archive_key text primary key,
  source text not null,
  sha256 text not null,
  bytes_compressed bigint not null check(bytes_compressed >= 0),
  start_at timestamptz,
  end_at timestamptz,
  records bigint check(records >= 0),
  uploaded_at timestamptz not null default now()
);

-- Private schema is NOT in the Supabase Data API exposed schemas.
-- Defense in depth: RLS on every table, with no browser-readable policies.
alter table pi.wallets enable row level security;
alter table pi.events enable row level security;
alter table pi.markets enable row level security;
alter table pi.trades enable row level security;
alter table pi.position_snapshots enable row level security;
alter table pi.wallet_activity enable row level security;
alter table pi.wallet_pnl_daily enable row level security;
alter table pi.wallet_equity_daily enable row level security;
alter table pi.wallet_metrics_daily enable row level security;
alter table pi.ingestion_jobs enable row level security;
alter table pi.ingestion_cursors enable row level security;
alter table pi.raw_archives enable row level security;

revoke all on all tables in schema pi from public, anon, authenticated;
revoke all on all sequences in schema pi from public, anon, authenticated;

commit;
