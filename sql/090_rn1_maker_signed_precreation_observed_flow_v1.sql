-- RN1 observed pre-signature executed flow features, bounded to November's 1361 decoded
-- original EIP712 Maker order hashes. Source is a PARTIAL 80k-fill archive of BUYs.
-- Observation of a prior fill is evidence; absence is NOT no position/no order.
-- All source fills used here satisfy trade_at < declared_created_at strictly.
create table if not exists pi.rn1_maker_signed_precreation_flow_v1 as
with ord as (
 select a.order_hash,a.sampled_cohort,a.event_slug,a.market_key,
  a.declared_created_at,a.first_fill_at,a.quote_status,
  a.signed_price,a.signed_order_shares,a.signed_notional_usdc,
  a.price_before,a.response_age_seconds,a.observed_before_epoch,
  a.five_min_momentum,a.signed_minus_prior_indicator,
  c.token_id
 from pi.rn1_maker_signed_creation_price_analysis a
 join pi.rn1_maker_calldata_signed_orders c using(order_hash)
 where a.declared_created_at is not null and a.event_slug is not null
)
select o.*,
 mod(abs(hashtext(o.event_slug)::bigint),5)::integer event_fold,
 x.maker_count_5m,x.taker_count_5m,
 coalesce(x.same_maker_shares_5m,0)::numeric same_maker_shares_5m,
 coalesce(x.opposite_maker_shares_5m,0)::numeric opposite_maker_shares_5m,
 x.maker_count_30m,
 coalesce(x.same_maker_shares_30m,0)::numeric same_maker_shares_30m,
 coalesce(x.opposite_maker_shares_30m,0)::numeric opposite_maker_shares_30m,
 x.maker_count_30s,
 x.last_any_maker_at,
 prev.trade_at last_same_maker_at,
 prev.price last_same_maker_fill_price,
 prev.shares last_same_maker_fill_shares,
 case when x.maker_count_5m=0 then 'no_observed_maker_5m'
   when coalesce(x.same_maker_shares_5m,0)>coalesce(x.opposite_maker_shares_5m,0) then 'same_side_dominant'
   when coalesce(x.same_maker_shares_5m,0)<coalesce(x.opposite_maker_shares_5m,0) then 'opposite_side_dominant'
   else 'balanced_observed_flow' end flow_regime_5m,
 case when x.maker_count_30m=0 then 'no_observed_maker_30m'
   when coalesce(x.same_maker_shares_30m,0)>coalesce(x.opposite_maker_shares_30m,0) then 'same_side_dominant'
   when coalesce(x.same_maker_shares_30m,0)<coalesce(x.opposite_maker_shares_30m,0) then 'opposite_side_dominant'
   else 'balanced_observed_flow' end flow_regime_30m,
 (
  o.quote_status='confirmed'
  and o.price_before between .01 and .99
  and o.signed_price between .01 and .99
  and o.signed_minus_prior_indicator is not null
  and o.declared_created_at<=o.first_fill_at
  and o.response_age_seconds between 0 and 90
  and o.observed_before_epoch <= extract(epoch from o.declared_created_at)
 ) as valid_signed_limit_reference,
 now() as computed_at
from ord o
left join lateral (
 select
 count(*) filter(where f.role='maker' and f.trade_at >= o.declared_created_at-interval '5 minutes')::integer maker_count_5m,
 count(*) filter(where f.role='taker' and f.trade_at >= o.declared_created_at-interval '5 minutes')::integer taker_count_5m,
 sum(f.shares) filter(where f.role='maker' and f.token_id=o.token_id and f.trade_at >= o.declared_created_at-interval '5 minutes') same_maker_shares_5m,
 sum(f.shares) filter(where f.role='maker' and f.token_id<>o.token_id and f.trade_at >= o.declared_created_at-interval '5 minutes') opposite_maker_shares_5m,
 count(*) filter(where f.role='maker')::integer maker_count_30m,
 sum(f.shares) filter(where f.role='maker' and f.token_id=o.token_id) same_maker_shares_30m,
 sum(f.shares) filter(where f.role='maker' and f.token_id<>o.token_id) opposite_maker_shares_30m,
 count(*) filter(where f.role='maker' and f.trade_at >= o.declared_created_at-interval '30 seconds')::integer maker_count_30s,
 max(f.trade_at) filter(where f.role='maker') last_any_maker_at
 from pi.rn1_maker_historical_fills f
 where f.event_slug=o.event_slug and f.market_key=o.market_key
   and f.trade_at < o.declared_created_at
   and f.trade_at >= o.declared_created_at-interval '30 minutes'
) x on true
left join lateral (
 select f.trade_at,f.price,f.shares
 from pi.rn1_maker_historical_fills f
 where f.event_slug=o.event_slug and f.market_key=o.market_key
   and f.token_id=o.token_id and f.role='maker'
   and f.trade_at < o.declared_created_at
   and f.trade_at >= o.declared_created_at-interval '5 minutes'
 order by f.trade_at desc,f.fingerprint desc limit 1
) prev on true;
alter table pi.rn1_maker_signed_precreation_flow_v1 enable row level security;
revoke all on pi.rn1_maker_signed_precreation_flow_v1 from anon,authenticated;
create unique index if not exists rn1_precreation_flow_order_hash_idx
 on pi.rn1_maker_signed_precreation_flow_v1(order_hash);
create index if not exists rn1_precreation_flow_event_idx
 on pi.rn1_maker_signed_precreation_flow_v1(event_slug,event_fold);
comment on table pi.rn1_maker_signed_precreation_flow_v1 is
 'Previously observed Maker BUY fills only; NOT full inventory and NOT nonexecuted orders. Strictly before declared creation time.';
