-- RN1 post-fill economics and inventory: large-cohort, read-only evaluation.
-- Run each SELECT separately. Do not label market-level correlation as trade-causal.
-- Coverage: full trades are archived but the verified sequential replay is
-- still only 134k fills. Archive inventory excludes transfers/merge/redeem.
-- Market cashflow excludes costs not in public sources. No net ROI claims.

-- 1. Complete chronological executed-flow COHORT (134,000).
-- Note: BUY/SELL execution-flow proxy, not on-chain holdings.
with page as (
 select sample_half,stats from pi.rn1_sequence_page_stats
), a as (
 select sample_half,
 sum((stats->>'fills')::bigint) fills,
 sum((stats->>'comparable_buy_fills')::bigint) comparable_buys,
 sum((stats->>'reduces_gap_buys')::bigint) decreases_gap,
 sum((stats->>'increases_gap_buys')::bigint) increases_gap,
 sum((stats->>'unchanged_gap_buys')::bigint) unchanged_gap,
 sum((stats->>'underweight_buys')::bigint) buys_underweight,
 sum((stats->>'overweight_buys')::bigint) buys_overweight,
 sum((stats->>'overcorrects_buys')::bigint) overcorrects
 from page group by rollup(sample_half)
)
select coalesce(sample_half,'all') period,fills,comparable_buys,
 decreases_gap,increases_gap,unchanged_gap,
 round(100*decreases_gap::numeric/nullif(comparable_buys,0),2) pct_rebalancing,
 buys_underweight,buys_overweight,overcorrects
from a order by period;

-- 2. Economically reconciled markets (fixed cohort 2026-09-21 to 2026-11-12).
-- Outcome-level net imbalance versus paired edge. This query does NOT prove
-- the maker fill itself caused a subsequent move or that its price was at bid.
with account as(
 select market_key,sum(reported_usdc_size) filter(where kind='REDEEM') redeemed,
 sum(reported_usdc_size) filter(where kind='MERGE') merged
 from pi.rn1_full_activity_metrics where kind in ('REDEEM','MERGE')
 group by market_key
), eligible as (
 select m.market_key,m.event_slug,m.buy0_shares,m.buy1_shares,
 m.buy0_cost,m.buy1_cost,coalesce(a.redeemed,0) redeemed,
 coalesce(a.redeemed,0)+coalesce(a.merged,0) returned,
 least(abs(coalesce(a.redeemed,0)+coalesce(a.merged,0)-m.buy0_shares),
       abs(coalesce(a.redeemed,0)+coalesce(a.merged,0)-m.buy1_shares)) mismatch
 from pi.rn1_full_market_metrics m left join account a using(market_key)
 where m.min_trade_at>='2026-09-21' and m.max_trade_at<'2026-11-12'
 and m.buy0_shares>0 and m.buy1_shares>0
), reconciled as (
 select *,greatest(buy0_shares,buy1_shares)
 /nullif(least(buy0_shares,buy1_shares),0) skew_ratio,
 returned-buy0_cost-buy1_cost gross,
 least(buy0_shares,buy1_shares)*
 (1-buy0_cost/buy0_shares-buy1_cost/buy1_shares) paired_gross
 from eligible where redeemed>0 and mismatch<=1
), grouped as (
 select case when skew_ratio<1.1 then 'below_1_1'
 when skew_ratio<1.5 then '1_1_to_1_5'
 when skew_ratio<2 then '1_5_to_2'
 else 'at_least_2' end exposure_band,* from reconciled
)
select exposure_band,count(*) markets,count(distinct event_slug) events,
 round(sum(gross),2) gross,round(sum(paired_gross),2) paired_gross,
 round(sum(gross-paired_gross),2) residual_gross,
 round(100*count(*) filter(where gross>0)::numeric/nullif(count(*),0),2)
 pct_positive_markets
from grouped group by 1 order by 1;

-- 3. Small DISTINCT historical price-reference dataset, included ONLY
-- to quantify missing forward-price coverage, NOT generalized to 732k maker fills.
select count(*) covered_fills,count(distinct market_key) markets,
 count(distinct bought_at::date) days,
 round(sum(shares*(after_15m_price-fill_price))
 /nullif(sum(shares),0),5) weighted_15m_markout_per_share,
 round(100*count(*) filter(where after_15m_price>fill_price)::numeric
 /nullif(count(*),0),2) positive_markout_pct,
 round(avg(after_15m_epoch-extract(epoch from bought_at)),1)
 avg_forward_lag_seconds
from pi.rn1_fill_price_benchmark
where after_15m_price is not null
and after_15m_epoch>extract(epoch from bought_at)
and reference_epoch<=extract(epoch from bought_at);

-- 4. Archive maker role audit coverage; maker inference is verified on
-- source pages, not joined to individual old benchmark fills.
select role_status,count(*) pages,sum(valid_count) fills,
 sum(maker_fills) maker,sum(taker_fills) taker
from pi.rn1_full_archive_pages
where stream='trades_all' group by role_status order by role_status;
