-- RN1 public trade pilot. Private raw page provenance; no assumption that a transaction hash is a unique fill.
-- A BOUNDED research sample, not a complete lifetime ledger or statement of profitability.
alter table pi.trades add column if not exists outcome_index smallint,
  add column if not exists outcome_label text,
  add column if not exists event_slug text,
  add column if not exists market_slug text,
  add column if not exists source_row_index integer;

create table if not exists pi.rn1_trade_pages(
 page_sha text primary key,
 wallet text not null references pi.wallets(wallet),
 source_path text not null default '/v2/trades',
 requested_cursor text,
 returned_cursor text,
 fetched_at timestamptz not null default now(),
 row_count integer not null check(row_count>=0 and row_count<=500),
 first_trade_ts timestamptz,
 last_trade_ts timestamptz,
 raw_payload jsonb not null,
 constraint pi_rn1_payload_shape check(jsonb_typeof(raw_payload)='object')
);
create index if not exists idx_pi_rn1_pages_time on pi.rn1_trade_pages(wallet,fetched_at desc);

create table if not exists pi.rn1_trade_import_state(
 wallet text primary key references pi.wallets(wallet),
 next_cursor text,
 status text not null default 'collecting' check (status in('collecting','pilot_complete','source_exhausted','paused')),
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
create index if not exists idx_pi_rn1_trade_source on pi.trades(wallet,market_key,reported_at)
 where wallet='0x2005d16a84ceefa912d4e380cd32e7ff827875ea';

alter table pi.rn1_trade_pages enable row level security;
alter table pi.rn1_trade_import_state enable row level security;
revoke all on pi.rn1_trade_pages,pi.rn1_trade_import_state from public,anon,authenticated;
grant select,insert,update,delete on pi.rn1_trade_pages,pi.rn1_trade_import_state to service_role;
