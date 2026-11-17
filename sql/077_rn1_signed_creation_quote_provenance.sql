-- RN1: strictly preceding Polymarket price indicators at the signer-declared
-- timestamp for the hash-verified signed-order subsample.
-- This is a retrospective history, NOT a contemporaneously captured bid/ask
-- and it does not prove the indicator was available to RN1 when signing.
create table if not exists pi.rn1_maker_signed_creation_quotes(
 order_hash text primary key,
 status text not null default 'pending'
  check(status in ('pending','confirmed','missing','error')),
 price_before numeric,
 observed_before_epoch bigint,
 price_5min_before numeric,
 observed_5min_epoch bigint,
 history_points integer not null default 0,
 response_age_seconds numeric,
 five_min_momentum numeric,
 error_attempts integer not null default 0,
 error_message text,
 lease_until timestamptz,
 updated_at timestamptz not null default now(),
 check(price_before is null or price_before between 0 and 1),
 check(price_5min_before is null or price_5min_before between 0 and 1)
);
alter table pi.rn1_maker_signed_creation_quotes enable row level security;
revoke all on pi.rn1_maker_signed_creation_quotes from anon,authenticated;
insert into pi.rn1_maker_signed_creation_quotes(order_hash)
select order_hash from pi.rn1_maker_calldata_signed_orders on conflict do nothing;

create or replace view pi.rn1_maker_signed_creation_price_analysis
with (security_invoker=true) as
select a.*,q.status quote_status,
 q.price_before,q.observed_before_epoch,q.response_age_seconds,
 q.price_5min_before,q.observed_5min_epoch,q.five_min_momentum,
 a.signed_price-q.price_before signed_minus_prior_indicator
from pi.rn1_maker_calldata_execution_analysis a
join pi.rn1_maker_signed_creation_quotes q on q.order_hash=a.order_hash;
revoke all on pi.rn1_maker_signed_creation_price_analysis
from anon,authenticated;

-- Worker:
-- 1. Claim an order with transaction lease and max three retries.
-- 2. Query only +/- ~15 minutes around the signed timestamp.
-- 3. Use only price at/before (floor(declared_created_ms/1000)).
-- 4. The latest price must be <=90 seconds old; earlier baseline at
--    [300, 420] seconds old; ignore absent windows.
-- 5. Store only short joined aggregates, not full price histories.
-- Cron 20 was unscheduled on 17 Nov 2026 after 1,361/1,361 were classified.
-- Query guards:
-- select count(*) from pi.rn1_maker_signed_creation_price_analysis
-- where observed_before_epoch>floor(declared_created_ms/1000.0);
-- Expected 0 (future leakage).
