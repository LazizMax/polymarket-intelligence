-- H11, prespecified before inspecting prediction scores:
-- Does observed Maker BUY flow in the five minutes before declared order
-- creation improve signed buy limit price prediction over a constant offset?
-- Training = random_tx cohort, event-disjoint CV (5 deterministic event folds).
-- Additional holdout = multi_level + persistent_order orders whose events do
-- NOT appear in random_tx at all. This holdout has cohort-selection bias.
-- Features are STRICTLY prior executions (not full inventory, no book snapshots).
-- A 5m group-specific median is used only when >=30 training orders; else global.
-- All thresholds and baselines are fixed here; no tuning based on test scores.
create table if not exists pi.rn1_maker_flow_policy_validation_v1 as
with eligible as (
 select order_hash,event_slug,market_key,sampled_cohort,declared_created_at,event_fold,
  signed_price::float8 signed_price,price_before::float8 price_before,
  signed_minus_prior_indicator::float8 signed_gap,
  flow_regime_5m,flow_regime_30m,
  maker_count_5m,maker_count_30m,
  same_maker_shares_5m,opposite_maker_shares_5m,
  last_same_maker_fill_price,last_same_maker_at
 from pi.rn1_maker_signed_precreation_flow_v1
 where valid_signed_limit_reference
), reference as (
 select * from eligible where sampled_cohort='random_tx'
), new_event_holdout as (
 select e.* from eligible e
 where e.sampled_cohort in ('multi_level','persistent_order')
  and not exists(select 1 from reference r where r.event_slug=e.event_slug)
), train_global as (
 select g.event_fold,count(*)::integer train_n,count(distinct r.event_slug)::integer train_events,
  percentile_cont(.5) within group(order by r.signed_gap) train_gap
 from generate_series(0,4) g(event_fold)
 join reference r on r.event_fold<>g.event_fold
 group by g.event_fold
), train_regime as (
 select g.event_fold,r.flow_regime_5m,count(*)::integer train_regime_n,
  percentile_cont(.5) within group(order by r.signed_gap) train_regime_gap
 from generate_series(0,4) g(event_fold)
 join reference r on r.event_fold<>g.event_fold
 group by g.event_fold,r.flow_regime_5m
), train_full_global as (
 select count(*)::integer train_n,count(distinct event_slug)::integer train_events,
  percentile_cont(.5) within group(order by signed_gap) train_gap
 from reference
), train_full_regime as (
 select flow_regime_5m,count(*)::integer train_regime_n,
  percentile_cont(.5) within group(order by signed_gap) train_regime_gap
 from reference group by flow_regime_5m
), combined as (
 select 'reference_oof'::text validation_group,r.*,g.train_n,g.train_events,g.train_gap,
   coalesce(c.train_regime_n,0) train_regime_n,
   case when c.train_regime_n>=30 then c.train_regime_gap else g.train_gap end flow_gap
 from reference r join train_global g on g.event_fold=r.event_fold
 left join train_regime c on c.event_fold=r.event_fold and c.flow_regime_5m=r.flow_regime_5m
 union all
 select 'new_event_targeted_holdout'::text validation_group,h.*,g.train_n,g.train_events,g.train_gap,
   coalesce(c.train_regime_n,0) train_regime_n,
   case when c.train_regime_n>=30 then c.train_regime_gap else g.train_gap end flow_gap
 from new_event_holdout h cross join train_full_global g
 left join train_full_regime c using(flow_regime_5m)
)
select validation_group,order_hash,event_slug,market_key,sampled_cohort,event_fold,
 declared_created_at,signed_price,price_before,signed_gap,flow_regime_5m,
 flow_regime_30m,maker_count_5m,maker_count_30m,
 same_maker_shares_5m,opposite_maker_shares_5m,
 last_same_maker_fill_price,last_same_maker_at,
 train_n,train_events,train_regime_n,train_gap,flow_gap,
 price_before+train_gap predicted_constant,
 price_before+flow_gap predicted_flow,
 abs(signed_price-(price_before+train_gap)) abs_error_constant,
 abs(signed_price-(price_before+flow_gap)) abs_error_flow,
 now() computed_at
from combined;
alter table pi.rn1_maker_flow_policy_validation_v1 enable row level security;
revoke all on pi.rn1_maker_flow_policy_validation_v1 from anon,authenticated;
create unique index if not exists rn1_maker_flow_policy_order_hash_idx
 on pi.rn1_maker_flow_policy_validation_v1(order_hash);
create index if not exists rn1_maker_flow_policy_event_idx
 on pi.rn1_maker_flow_policy_validation_v1(validation_group,event_slug);
comment on table pi.rn1_maker_flow_policy_validation_v1 is
 'H11: five-minute prior executed Maker BUY flow class vs constant signed limit offset. Targeted external-event holdout is cohort-biased; no Maker order placement causality or PnL inference.';
