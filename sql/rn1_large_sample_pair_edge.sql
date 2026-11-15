-- RN1 large-sample gross complementary purchase cost diagnostics.
-- READ ONLY. The public source and SQL aggregates here currently track BUY fills;
-- no sell, redemption, fee or realized account balance is inferred.
-- If a market has 100 YES at avg 0.45 and 100 NO at avg 0.53,
-- its paired purchase spread is 0.02 per matched pair; leftover side unhedged.
-- Not true executable arbitrage or realized PnL. Archives may be incomplete.
-- Source pi.rn1_full_market_metrics covers only metrics_rows already materialized.
-- All SELECTs work without table creation and should be run separately.

-- A) Coverage and source health: confirmed before every presentation.
select stream,status,pages_fetched,rows_valid,metrics_rows,
       metrics_paused_at,source_exhausted_at,last_success_at
from pi.rn1_full_streams order by stream;

-- B) All materially summarized RN1 BUY fills, market-level opportunities.
with market as (
 select market_key,event_slug,fills,buy_fills,sell_fills,
        least(buy0_shares,buy1_shares) as pair_shares,
        case when buy0_shares>0 and buy1_shares>0 then
          buy0_cost/buy0_shares+buy1_cost/buy1_shares end as pair_cost
 from pi.rn1_full_market_metrics
)
select count(*) markets, sum(fills) observed_fills,
       sum(buy_fills) buy_fills, sum(sell_fills) sell_fills,
       count(*) filter(where pair_shares>0) two_sided_markets,
       count(*) filter(where pair_shares>0 and pair_cost<1) below_one_markets,
       sum(fills) filter(where pair_shares>0) fills_in_two_sided_markets,
       sum(pair_shares) filter(where pair_shares>0) pair_shares,
       sum(pair_shares*pair_cost) filter(where pair_shares>0)
         /nullif(sum(pair_shares) filter(where pair_shares>0),0)
         as paired_shares_weighted_purchase_cost,
       sum(pair_shares*(1-pair_cost)) filter(where pair_shares>0)
         as ex_post_algebraic_pair_margin_before_fees
from market;

-- C) Stability across market completion weeks. This groups a whole market
-- by LAST observed trade, not individual executions' actual week; do NOT
-- treat as fully out-of-sample or causal time-series of individual fills.
with market as(
 select date_trunc('week',max_trade_at)::date as last_trade_week,
        fills,least(buy0_shares,buy1_shares) as pair_shares,
        case when buy0_shares>0 and buy1_shares>0 then
          buy0_cost/buy0_shares+buy1_cost/buy1_shares end as pair_cost
 from pi.rn1_full_market_metrics
)
select last_trade_week,count(*) markets,sum(fills) fills,
       count(*) filter(where pair_shares>0) two_sided,
       count(*) filter(where pair_shares>0 and pair_cost<1) favorable,
       sum(pair_shares*pair_cost) filter(where pair_shares>0)
         /nullif(sum(pair_shares) filter(where pair_shares>0),0)
         as weighted_pair_cost,
       sum(pair_shares*(1-pair_cost)) filter(where pair_shares>0)
         as algebraic_pair_margin
from market group by 1 order by 1;

-- D) Heterogeneity by fill count, with a clearly unfilled residual side.
with market as(
 select fills,least(buy0_shares,buy1_shares) pair_shares,
        greatest(buy0_shares,buy1_shares)
         /nullif(least(buy0_shares,buy1_shares),0) skew_ratio,
        case when buy0_shares>0 and buy1_shares>0 then
          buy0_cost/buy0_shares+buy1_cost/buy1_shares end pair_cost
 from pi.rn1_full_market_metrics
), eligible as(
 select case when fills<3 then '1-2'
             when fills<10 then '3-9'
             when fills<30 then '10-29'
             else '30+' end fills_band,* from market where pair_shares>0
)
select fills_band,count(*) markets,sum(fills) fills,
       count(*) filter(where pair_cost<1) favorable,
       sum(pair_shares*pair_cost)/nullif(sum(pair_shares),0) weighted_pair_cost,
       avg(skew_ratio) avg_skew_ratio
from eligible group by 1 order by 1;
