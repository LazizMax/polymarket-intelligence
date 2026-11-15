-- Private provenance of official Polymarket outcome payouts and historical token price observations.
-- No lookahead is permitted in analysis: price buckets must end before a fill timestamp.
-- Neither price history nor hypothetical payout is a historical executable order book.
create table if not exists pi.rn1_resolution_evidence(
 market_key text primary key,
 status text not null,
 payouts jsonb,
 resolved_at timestamptz,
 source_record jsonb not null,
 fetched_at timestamptz not null default now(),
 source_endpoint text not null default 'data-api/v2/resolutions'
);
create index if not exists idx_pi_rn1_resolution_status on pi.rn1_resolution_evidence(status);

create table if not exists pi.rn1_price_history_evidence(
 token_id text primary key,
 market_key text not null,
 outcome_index smallint not null check(outcome_index in(0,1)),
 request_id bigint unique,
 requested_from bigint not null,
 requested_to bigint not null,
 request_status text not null default 'queued'
    check(request_status in('queued','ok','http_error','invalid_response')),
 price_points integer,
 source_response jsonb,
 fetched_at timestamptz not null default now(),
 source_endpoint text not null default 'data-api/v2/prices-history',
 check(requested_from < requested_to)
);
create index if not exists idx_pi_rn1_price_market on pi.rn1_price_history_evidence(market_key,outcome_index);

alter table pi.rn1_resolution_evidence enable row level security;
alter table pi.rn1_price_history_evidence enable row level security;
revoke all on pi.rn1_resolution_evidence,pi.rn1_price_history_evidence from public,anon,authenticated;
grant select,insert,update,delete on pi.rn1_resolution_evidence,pi.rn1_price_history_evidence to service_role;
