-- RN1 long-range public source collector. Trades are explicitly requested with
-- taker_only=false; the 2026-11 pilot was taker-only and MUST NOT be treated as complete.
-- Archive every unmodified page as a compressed private Supabase Storage object.
-- Store only compact incrementally updated statistics in Postgres.
-- This project also hosts Fit Tracker: collectors STOP well before DB/Storage quotas.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('pi-rn1-research-private','pi-rn1-research-private',false,20000000,array['application/gzip']::text[])
on conflict(id) do nothing;

create table if not exists pi.rn1_full_streams(
 stream text primary key check (stream in ('trades_all','activity_all')),
 wallet text not null references pi.wallets(wallet),
 source_path text not null,
 source_params jsonb not null,
 next_cursor text,
 status text not null default 'collecting'
  check(status in('collecting','paused_quota','paused_error','source_exhausted')),
 pages_fetched bigint not null default 0,
 rows_seen bigint not null default 0,
 rows_valid bigint not null default 0,
 rows_invalid bigint not null default 0,
 raw_gzip_bytes bigint not null default 0,
 first_seen_at timestamptz,
 last_seen_at timestamptz,
 last_success_at timestamptz,
 last_error text,
 lease_until timestamptz,
 updated_at timestamptz not null default now(),
 max_raw_bytes bigint not null default 734003200 check(max_raw_bytes between 52428800 and 1073741824),
 max_db_bytes bigint not null default 335544320 check(max_db_bytes between 104857600 and 1073741824),
 source_exhausted_at timestamptz
);
create table if not exists pi.rn1_full_archive_pages(
 stream text not null references pi.rn1_full_streams(stream),
 page_no bigint not null,
 sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
 storage_key text not null,
 cursor_in text,
 cursor_out text,
 fetched_at timestamptz not null default now(),
 row_count integer not null check(row_count between 0 and 1000),
 valid_count integer not null check(valid_count between 0 and 1000),
 invalid_count integer not null check(invalid_count between 0 and 1000),
 compressed_bytes bigint not null check(compressed_bytes>0 and compressed_bytes<=20000000),
 min_reported_at timestamptz,
 max_reported_at timestamptz,
 primary key(stream,page_no),
 unique(stream,sha256),
 unique(storage_key),
 check(row_count=valid_count+invalid_count)
);
create index if not exists idx_pi_rn1_archive_pages_time
 on pi.rn1_full_archive_pages(stream,min_reported_at);

create table if not exists pi.rn1_full_market_metrics(
 wallet text not null,
 market_key text not null,
 title text,
 event_slug text,
 fills bigint not null default 0,
 buy_fills bigint not null default 0,
 sell_fills bigint not null default 0,
 buy0_shares numeric not null default 0,
 buy1_shares numeric not null default 0,
 sell0_shares numeric not null default 0,
 sell1_shares numeric not null default 0,
 buy0_cost numeric not null default 0,
 buy1_cost numeric not null default 0,
 sell0_proceeds numeric not null default 0,
 sell1_proceeds numeric not null default 0,
 unknown_outcome_fills bigint not null default 0,
 min_trade_at timestamptz,
 max_trade_at timestamptz,
 first_seen_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key(wallet,market_key)
);
create index if not exists idx_pi_rn1_full_markets_activity
 on pi.rn1_full_market_metrics(wallet,max_trade_at desc);

create table if not exists pi.rn1_full_activity_metrics(
 wallet text not null,
 market_key text not null,
 kind text not null,
 events bigint not null default 0,
 reported_usdc_size numeric not null default 0,
 amount_present bigint not null default 0,
 min_event_at timestamptz,
 max_event_at timestamptz,
 primary key(wallet,market_key,kind)
);
create index if not exists idx_pi_rn1_full_activity_kind on pi.rn1_full_activity_metrics(wallet,kind);

alter table pi.rn1_full_streams enable row level security;
alter table pi.rn1_full_archive_pages enable row level security;
alter table pi.rn1_full_market_metrics enable row level security;
alter table pi.rn1_full_activity_metrics enable row level security;
revoke all on pi.rn1_full_streams,pi.rn1_full_archive_pages,pi.rn1_full_market_metrics,pi.rn1_full_activity_metrics
 from public,anon,authenticated;
grant select,insert,update,delete on
 pi.rn1_full_streams,pi.rn1_full_archive_pages,pi.rn1_full_market_metrics,pi.rn1_full_activity_metrics
 to service_role;

insert into pi.rn1_full_streams(stream,wallet,source_path,source_params)
values
 ('trades_all','0x2005d16a84ceefa912d4e380cd32e7ff827875ea','/v2/trades',
  '{"user":"0x2005d16a84ceefa912d4e380cd32e7ff827875ea","start":"1","limit":"1000","taker_only":"false"}'),
 ('activity_all','0x2005d16a84ceefa912d4e380cd32e7ff827875ea','/v2/activity',
  '{"user":"0x2005d16a84ceefa912d4e380cd32e7ff827875ea","start":"1","limit":"1000"}')
on conflict(stream) do nothing;
