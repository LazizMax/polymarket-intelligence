-- Reproducible RN1 pricing / directional-result research cohort.
-- Market-level snapshots, not a claim of complete wallet inventory or realized PnL.
-- Stratified by UTC week (8), buy-side count (1 vs 2), and notional tercile (3).
-- Exactly 12 markets per stratum, one market per sporting event within each stratum.
-- Official outcomes are joined separately from pi.rn1_resolution_evidence.
create table if not exists pi.rn1_price_edge_cohort(
 market_key text primary key check (market_key ~ '^0x[0-9a-f]{64}$'),
 event_slug text not null,
 sampled_week date not null,
 side_group text not null check(side_group in('both','single')),
 notional_tercile smallint not null check(notional_tercile between 1 and 3),
 frozen_buy0_shares numeric not null check(frozen_buy0_shares>=0),
 frozen_buy1_shares numeric not null check(frozen_buy1_shares>=0),
 frozen_buy0_cost numeric not null check(frozen_buy0_cost>=0),
 frozen_buy1_cost numeric not null check(frozen_buy1_cost>=0),
 frozen_first_trade_at timestamptz not null,
 frozen_last_trade_at timestamptz not null,
 selection_version text not null default 'rn1_edge_2026_11_15_v2',
 sampled_at timestamptz not null default now(),
 resolution_request_id bigint,
 constraint rn1_price_edge_period check(frozen_first_trade_at<=frozen_last_trade_at)
);
create index if not exists rn1_price_edge_sample_week on pi.rn1_price_edge_cohort(sampled_week,side_group,notional_tercile);
alter table pi.rn1_price_edge_cohort enable row level security;
revoke all on pi.rn1_price_edge_cohort from public,anon,authenticated;
grant select,insert,update,delete on pi.rn1_price_edge_cohort to service_role;
-- Explicit fixed data cutoff to avoid moving targets while the full historical
-- collector continues crawling back toward older transactions.
with source as(
 select market_key,event_slug,date_trunc('week',max_trade_at)::date as week,
  buy0_shares,buy1_shares,buy0_cost,buy1_cost,min_trade_at,max_trade_at,
  case when buy0_shares>0 and buy1_shares>0 then 'both' else 'single' end sides,
  buy0_cost+buy1_cost usd
 from pi.rn1_full_market_metrics
 where wallet='0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
  and max_trade_at >= '2026-09-21T00:00:00+00'
  and max_trade_at < '2026-11-15T00:00:00+00'
  and max_trade_at - min_trade_at <= interval '48 hours'
), strata as(
 select *,ntile(3) over(partition by week,sides order by usd) as band from source
), events as(
 select *,row_number() over(partition by week,sides,band,event_slug
   order by md5(market_key)) event_rank from strata
), ranked as(
 select *,row_number() over(partition by week,sides,band
   order by md5(market_key||'rn1_edge_v2')) sample_rank
 from events where event_rank=1
)
insert into pi.rn1_price_edge_cohort(
 market_key,event_slug,sampled_week,side_group,notional_tercile,
 frozen_buy0_shares,frozen_buy1_shares,frozen_buy0_cost,frozen_buy1_cost,
 frozen_first_trade_at,frozen_last_trade_at)
select market_key,event_slug,week,sides,band,
buy0_shares,buy1_shares,buy0_cost,buy1_cost,min_trade_at,max_trade_at
from ranked where sample_rank<=12
on conflict(market_key) do nothing;
