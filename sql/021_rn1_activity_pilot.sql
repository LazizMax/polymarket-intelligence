-- RN1 V2 activity pilot: raw cursor provenance and economic event labels.
-- A reported redemption is NOT a realized PnL. Do not silently infer fees or inventory cost.
alter table pi.wallet_activity
 add column if not exists market_key text,
 add column if not exists token_id text,
 add column if not exists tx_hash text,
 add column if not exists side text,
 add column if not exists shares numeric,
 add column if not exists unit_price numeric,
 add column if not exists outcome_index smallint,
 add column if not exists event_slug text,
 add column if not exists market_title text,
 add column if not exists reported_usdc_size numeric,
 add column if not exists source_row_index integer;

create table if not exists pi.rn1_activity_pages(
 page_sha text primary key,
 wallet text not null references pi.wallets(wallet),
 source_path text not null default '/v2/activity',
 requested_cursor text,
 returned_cursor text,
 fetched_at timestamptz not null default now(),
 row_count integer not null check(row_count>=0 and row_count<=500),
 first_event_at timestamptz,
 last_event_at timestamptz,
 raw_payload jsonb not null,
 constraint rn1_activity_payload_object check(jsonb_typeof(raw_payload)='object')
);
create index if not exists idx_pi_rn1_activity_pages_time on pi.rn1_activity_pages(wallet,fetched_at desc);

create table if not exists pi.rn1_activity_import_state(
 wallet text primary key references pi.wallets(wallet),
 next_cursor text,
 status text not null default 'collecting' check(status in('collecting','pilot_complete','source_exhausted','paused')),
 pages_fetched integer not null default 0,
 rows_seen integer not null default 0,
 rows_stored integer not null default 0,
 missing_required integer not null default 0,
 sample_limit integer not null default 4000 check(sample_limit between 200 and 20000),
 lease_until timestamptz,
 last_success_at timestamptz,
 last_error text,
 updated_at timestamptz not null default now()
);
-- Reconciliation joins on transaction hash and token, not just the market.
create index if not exists idx_pi_rn1_trade_matching
 on pi.trades(wallet,tx_hash,token_id,side)
 where wallet='0x2005d16a84ceefa912d4e380cd32e7ff827875ea';

create index if not exists idx_pi_rn1_activity_source
 on pi.wallet_activity(wallet,market_key,occurred_at)
 where wallet='0x2005d16a84ceefa912d4e380cd32e7ff827875ea';

alter table pi.rn1_activity_pages enable row level security;
alter table pi.rn1_activity_import_state enable row level security;
revoke all on pi.rn1_activity_pages,pi.rn1_activity_import_state from public,anon,authenticated;
grant select,insert,update,delete on pi.rn1_activity_pages,pi.rn1_activity_import_state to service_role;
