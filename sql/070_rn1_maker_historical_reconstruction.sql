-- RN1 historical Maker reconstruction: private, bounded source-normalization cohort.
-- Deployed first to dedicated Supabase project as migration rn1_maker_historical_reconstruction_v1.
create table if not exists pi.rn1_maker_historical_fills (
 fingerprint text primary key,
 page_no bigint not null,
 trade_at timestamptz not null,
 token_id text not null,
 market_key text not null,
 event_slug text,
 side text not null check(side in ('BUY','SELL')),
 role text not null check(role in ('maker','taker')),
 outcome_index smallint,
 price numeric not null,
 shares numeric not null,
 pre_price numeric,
 pre_price_at timestamptz,
 pre_price_age_seconds integer,
 momentum_5m numeric,
 score_home smallint,
 score_away smallint,
 score_event_at timestamptz,
 score_age_seconds integer,
 created_at timestamptz not null default now()
);
create index if not exists rn1_maker_hist_event_idx on pi.rn1_maker_historical_fills(event_slug,trade_at);
create index if not exists rn1_maker_hist_token_idx on pi.rn1_maker_historical_fills(token_id,trade_at);
create table if not exists pi.rn1_maker_historical_pages (
 page_no bigint primary key,
 source_sha256 text not null,
 maker_fills integer not null,
 taker_fills integer not null,
 matched_price integer not null,
 matched_score integer not null,
 processed_at timestamptz not null default now()
);
alter table pi.rn1_maker_historical_fills enable row level security;
alter table pi.rn1_maker_historical_pages enable row level security;
revoke all on pi.rn1_maker_historical_fills,pi.rn1_maker_historical_pages from anon,authenticated;
create or replace view pi.rn1_maker_historical_minute_panel with (security_invoker=true) as
with token_events as (
 select token_id,min(event_slug) event_slug from pi.rn1_maker_historical_fills
 where event_slug is not null group by token_id having count(distinct event_slug)=1
),
prices as (
 select p.token_id,p.observed_epoch,p.price,p.resolution_seconds,
 lag(p.price,5) over(partition by p.token_id order by p.observed_epoch) price_lag5,
 lag(p.observed_epoch,5) over(partition by p.token_id order by p.observed_epoch) epoch_lag5
 from pi.rn1_historical_price_points p
 where p.resolution_seconds=60 and p.price between 0.01 and 0.99
),
coverage as (
 select min(trade_at) min_trade_at,max(trade_at) max_trade_at from pi.rn1_maker_historical_fills
)
select te.event_slug,p.token_id,to_timestamp(p.observed_epoch) minute_at,p.price,
 case when p.observed_epoch-p.epoch_lag5 between 240 and 420 then p.price-p.price_lag5 end delta_5m,
 exists(select 1 from pi.rn1_maker_historical_fills f
 where f.token_id=p.token_id and f.role='maker'
 and f.trade_at>to_timestamp(p.observed_epoch) and f.trade_at<=to_timestamp(p.observed_epoch+60)) maker_fill_next_60s,
 (select count(*) from pi.rn1_maker_historical_fills f
 where f.token_id=p.token_id and f.role='maker'
 and f.trade_at>to_timestamp(p.observed_epoch) and f.trade_at<=to_timestamp(p.observed_epoch+60)) maker_fill_count_next_60s
from prices p join token_events te on te.token_id=p.token_id cross join coverage c
where to_timestamp(p.observed_epoch)>=c.min_trade_at+interval '60 seconds'
 and to_timestamp(p.observed_epoch+60)<=c.max_trade_at-interval '60 seconds';
revoke all on pi.rn1_maker_historical_minute_panel from anon,authenticated;
