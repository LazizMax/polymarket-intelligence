-- Normalized Polymarket public one-minute price observations for causal fill lookups.
-- Use price bucket END (timestamp+resolution_seconds) <= fill time to prohibit lookahead.
-- History is NOT a contemporaneous bid/ask and cannot identify passive vs aggressive fills.
create table if not exists pi.rn1_historical_price_points(
 token_id text not null references pi.rn1_price_history_evidence(token_id),
 observed_epoch bigint not null,
 resolution_seconds integer not null check(resolution_seconds between 0 and 43200),
 price numeric(18,10) not null check(price>=0 and price<=1),
 primary key(token_id,observed_epoch,resolution_seconds)
);
create index if not exists idx_pi_rn1_historical_price_time on pi.rn1_historical_price_points(token_id,observed_epoch desc);
alter table pi.rn1_historical_price_points enable row level security;
revoke all on pi.rn1_historical_price_points from public,anon,authenticated;
grant select,insert,update,delete on pi.rn1_historical_price_points to service_role;
