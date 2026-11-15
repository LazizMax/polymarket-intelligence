-- Polymarket closed outcome positions; *not* individual order fills or wallet equity.
-- Separate generation prevents mixing a partial refresh with a previous snapshot.
create table if not exists pi.roi_import_state (
 wallet text primary key references pi.wallets(wallet),
 generation bigint not null default 1,
 next_cursor text,
 exhausted boolean not null default false,
 request_priority boolean not null default false,
 pages_fetched integer not null default 0,
 rows_seen integer not null default 0,
 last_attempt_at timestamptz,
 last_success_at timestamptz,
 last_complete_at timestamptz,
 last_error text,
 updated_at timestamptz not null default now()
);
create index if not exists idx_pi_roi_sync_priority
 on pi.roi_import_state(request_priority desc,last_attempt_at asc nulls first)
 where exhausted=false;

create table if not exists pi.closed_position_roi (
 wallet text not null references pi.wallets(wallet),
 token_id text not null,
 generation bigint not null,
 condition_id text,
 title text,
 outcome text,
 market_slug text,
 first_entry_at timestamptz,
 last_event_at timestamptz,
 lifetime_shares numeric(38,12),
 avg_entry_price numeric(20,12),
 estimated_entry_cost_usdc numeric(28,8),
 realized_pnl_usdc numeric(28,8),
 estimated_roi_pct numeric(24,8),
 valid_cost boolean not null default false,
 quality_reason text,
 source_percent_realized_pnl numeric(24,8),
 collected_at timestamptz not null default now(),
 primary key(wallet,token_id)
);
create index if not exists idx_pi_closed_position_latest
 on pi.closed_position_roi(wallet,generation,last_event_at desc nulls last);
create index if not exists idx_pi_closed_position_market
 on pi.closed_position_roi(wallet,condition_id);

alter table pi.roi_import_state enable row level security;
alter table pi.closed_position_roi enable row level security;
revoke all on pi.roi_import_state,pi.closed_position_roi from public,anon,authenticated;
grant select,insert,update,delete on pi.roi_import_state,pi.closed_position_roi to service_role;
