-- RN1 signed limit price policy: event-disjoint internal cross-validation v1.
-- Critical: executed and retrospectively queried orders only, NOT original order submission population.
-- Five folds by event_slug. Training median gaps always exclude the held-out event fold.
-- Historical price point must predate claimed order creation and be <=90 seconds old.
-- Four predeclared simple predictors (no tuning on holdout):
-- M0 price_before; M1 price_before + global median signed gap (train folds only);
-- M2 prior + median gap for prior 5-min momentum regime; M3 prior + quote price quintile.
create table if not exists pi.rn1_maker_signed_limit_oof_v1 as
with base as (
 select order_hash,event_slug,declared_created_at,
 signed_price::float8 signed_price,price_before::float8 price_before,
 signed_minus_prior_indicator::float8 signed_gap,
 five_min_momentum::float8 momentum_5m,
 mod(abs(hashtext(event_slug)::bigint),5)::integer event_fold,
 case when five_min_momentum <= -0.01 then 'down_1pp'
      when five_min_momentum >= 0.01 then 'up_1pp'
      when five_min_momentum is null then 'missing_momentum'
      else 'flat_1pp' end momentum_regime,
 least(4,greatest(0,floor(price_before*5)::integer)) price_bucket
 from pi.rn1_maker_signed_creation_price_analysis
 where sampled_cohort='random_tx' and quote_status='confirmed'
   and event_slug is not null and price_before between .01 and .99
   and signed_price between .01 and .99 and signed_minus_prior_indicator is not null
   and declared_created_at <= first_fill_at
   and observed_before_epoch <= extract(epoch from declared_created_at)
   and response_age_seconds between 0 and 90
), train_global as (
 select f.event_fold,percentile_cont(.5) within group(order by b.signed_gap) median_gap
 from generate_series(0,4) f(event_fold) join base b on b.event_fold<>f.event_fold
 group by f.event_fold
), train_regime as (
 select f.event_fold,b.momentum_regime,percentile_cont(.5) within group(order by b.signed_gap) median_gap
 from generate_series(0,4) f(event_fold) join base b on b.event_fold<>f.event_fold
 group by f.event_fold,b.momentum_regime
), train_bucket as (
 select f.event_fold,b.price_bucket,percentile_cont(.5) within group(order by b.signed_gap) median_gap
 from generate_series(0,4) f(event_fold) join base b on b.event_fold<>f.event_fold
 group by f.event_fold,b.price_bucket
)
select b.order_hash,b.event_slug,b.declared_created_at,b.event_fold,
 b.momentum_regime,b.price_bucket,b.price_before,b.signed_price,
 b.signed_gap,b.momentum_5m,g.median_gap train_global_gap,
 r.median_gap train_momentum_gap,k.median_gap train_price_bucket_gap,
 b.price_before predicted_m0,
 b.price_before+g.median_gap predicted_m1,
 b.price_before+coalesce(r.median_gap,g.median_gap) predicted_m2,
 b.price_before+coalesce(k.median_gap,g.median_gap) predicted_m3,
 abs(b.signed_price-b.price_before) abs_error_m0,
 abs(b.signed_price-(b.price_before+g.median_gap)) abs_error_m1,
 abs(b.signed_price-(b.price_before+coalesce(r.median_gap,g.median_gap))) abs_error_m2,
 abs(b.signed_price-(b.price_before+coalesce(k.median_gap,g.median_gap))) abs_error_m3,
 now() as computed_at
from base b join train_global g using(event_fold)
left join train_regime r on r.event_fold=b.event_fold and r.momentum_regime=b.momentum_regime
left join train_bucket k on k.event_fold=b.event_fold and k.price_bucket=b.price_bucket;
alter table pi.rn1_maker_signed_limit_oof_v1 enable row level security;
revoke all on pi.rn1_maker_signed_limit_oof_v1 from anon,authenticated;
create unique index if not exists rn1_maker_limit_oof_order_hash_idx on pi.rn1_maker_signed_limit_oof_v1(order_hash);
create index if not exists rn1_maker_limit_oof_event_fold_idx on pi.rn1_maker_signed_limit_oof_v1(event_slug,event_fold);
comment on table pi.rn1_maker_signed_limit_oof_v1 is 'Internal event-disjoint cross validation on November executed Maker signed orders; not execution profit or prospective test';