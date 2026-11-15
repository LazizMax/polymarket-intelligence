-- Independent public market-price historical RN1 study: READ ONLY.
-- Uniform among sampled tokens, NOT fills. Population correction by
-- token inclusion probability (source_tokens/sampled_tokens).
-- Always report source coverage, matching fill count and time grouping.

-- Progress and security headroom
select status,pages_done,frozen_last_page,source_fills,
       sampled_buy_fills,sampled_maker_fills,sampled_taker_fills,
       sampled_unknown_fills,last_error,last_success_at
from pi.rn1_independent_price_jobs
where job_key='rn1_independent_price_v1';

-- Sampling frame and price-series availability
select count(*) pages,
 count(*) filter(where source_tokens is null) missing_sampling_frames,
 count(distinct date_trunc('week',min_trade_at)) weeks,
 sum(sampled_tokens) sampled_token_pages,
 sum(history_requests) requested_histories,
 sum(history_success) available_histories,
 sum(sampled_buy_fills) sampled_buy_fills
from pi.rn1_independent_price_pages;

-- All horizons: both unadjusted (biased by token counts) and
-- inverse-probability-weighted across tokens.
with p as(
 select page_no,summary,source_tokens::numeric/nullif(sampled_tokens,0) w
 from pi.rn1_independent_price_pages
 where source_tokens is not null and sampled_tokens>0
), h as(
 select j.key horizon,p.w,
  j.value->'maker|all' maker,
  j.value->'maker|underweight' under_m,
  j.value->'maker|overweight' over_m
 from p cross join lateral jsonb_each(p.summary->'market_price') j
)
select horizon,
 sum((maker->>'n')::numeric)::int observed_maker_fills,
 sum((maker->>'weighted')::numeric)
  /nullif(sum((maker->>'shares')::numeric),0) raw_quantity_markout,
 sum((maker->>'weighted')::numeric*w)
  /nullif(sum((maker->>'shares')::numeric*w),0) token_ipw_markout,
 sum((under_m->>'weighted')::numeric*w)
  /nullif(sum((under_m->>'shares')::numeric*w),0) underweight_token_ipw,
 sum((over_m->>'weighted')::numeric*w)
  /nullif(sum((over_m->>'shares')::numeric*w),0) overweight_token_ipw
from h group by horizon order by horizon::int;

-- Source page grouping is NOT equivalent to independent sporting events.
select date_trunc('week',min_trade_at)::date week,
 count(*) pages,sum(sampled_buy_fills) sampled_buys,
 sum((summary->'market_price'->'900'->'maker|all'->>'n')::numeric) maker_15m_fills,
 sum((summary->'market_price'->'900'->'maker|all'->>'weighted')::numeric
    *source_tokens/nullif(sampled_tokens,0))
 /nullif(sum((summary->'market_price'->'900'->'maker|all'->>'shares')::numeric
    *source_tokens/nullif(sampled_tokens,0)),0) maker_15m_token_ipw
from pi.rn1_independent_price_pages where source_tokens is not null
group by 1 order by 1;

-- Distinct event slug coverage (events may overlap multiple pages).
select count(distinct e.event_slug) event_slugs
from pi.rn1_independent_price_pages p
cross join lateral jsonb_array_elements_text(p.sample_event_slugs)
 as e(event_slug);
