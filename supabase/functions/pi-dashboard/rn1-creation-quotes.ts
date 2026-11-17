// Read-only quantitative diagnostics for prices strictly preceding the
// signer-declared timestamps of hash-verified RN1 Maker orders.
// Historical Polymarket prices are price indicators, NOT best bid/ask quotes.
export async function rn1SignedCreationPriceReport(db:any){
 const [coverage,regimes,periods,controls,sample]=await Promise.all([
  db.unsafe(`select status,count(*)::integer orders,
    count(*) filter(where five_min_momentum is not null)::integer valid_momentum,
    round(avg(response_age_seconds)::numeric,2)::float8 mean_quote_age_seconds
   from pi.rn1_maker_signed_creation_quotes group by status order by status`),
  db.unsafe(`with x as (
   select event_slug,signed_order_shares,age_to_first_fill_seconds,
   signed_minus_prior_indicator,response_age_seconds,observed_fill_ratio,
   case when five_min_momentum<-.01 then 'fall_gt1pt'
        when five_min_momentum>.01 then 'rise_gt1pt' else 'stable_1pt' end regime,
   five_min_momentum
   from pi.rn1_maker_signed_creation_price_analysis
   where sampled_cohort='random_tx' and quote_status='confirmed'
     and five_min_momentum is not null
  )
  select regime,count(*)::integer orders,count(distinct event_slug)::integer events,
   round(percentile_cont(.5) within group(order by signed_minus_prior_indicator)::numeric,4)::float8 median_signed_minus_prior,
   round(avg(signed_minus_prior_indicator)::numeric,4)::float8 mean_signed_minus_prior,
   round(100.0*avg((signed_minus_prior_indicator<-.005)::int)::numeric,2)::float8 pct_below_prior_halfpt,
   round(percentile_cont(.5) within group(order by signed_order_shares)::numeric,2)::float8 median_signed_shares,
   round(percentile_cont(.5) within group(order by observed_fill_ratio)::numeric,3)::float8 median_observed_fill_fraction,
   round(percentile_cont(.5) within group(order by response_age_seconds)::numeric,1)::float8 median_quote_age_seconds,
   count(*) filter(where response_age_seconds<=30)::integer recent_quotes,
   round(percentile_cont(.5) within group(order by signed_minus_prior_indicator)
    filter(where response_age_seconds<=30)::numeric,4)::float8 median_gap_recent_quote
  from x group by 1 order by 1`),
  db.unsafe(`select case when first_fill_at<'2026-11-09 20:39:27+00'::timestamptz
     then 'older' else 'recent' end period,
   count(*)::integer orders,count(distinct event_slug)::integer events,
   round(percentile_cont(.5) within group(order by signed_minus_prior_indicator)::numeric,4)::float8 median_signed_gap,
   round(100.0*avg((signed_minus_prior_indicator<-.005)::int)::numeric,2)::float8 pct_below_prior,
   round(percentile_cont(.5) within group(order by response_age_seconds)::numeric,1)::float8 median_quote_age_seconds
   from pi.rn1_maker_signed_creation_price_analysis
   where sampled_cohort='random_tx' and quote_status='confirmed'
   group by 1 order by 1`),
  db.unsafe(`with a as (
   select event_slug,signed_minus_prior_indicator,signed_order_shares,response_age_seconds,
   case when five_min_momentum<-.01 then 'fall'
        when five_min_momentum>.01 then 'rise' else 'flat' end regime
   from pi.rn1_maker_signed_creation_price_analysis
   where sampled_cohort='random_tx' and quote_status='confirmed'
    and five_min_momentum is not null
  ), e as (
   select event_slug,
    count(*) filter(where regime='fall') nf,count(*) filter(where regime='rise') nr,
    avg(signed_minus_prior_indicator) filter(where regime='fall') fall_gap,
    avg(signed_minus_prior_indicator) filter(where regime='rise') rise_gap
   from a group by event_slug
  )
  select count(*)::integer all_events,
   count(*) filter(where nf>=2 and nr>=2)::integer comparable_events,
   count(*) filter(where nf>=2 and nr>=2 and fall_gap<rise_gap)::integer more_discount_after_fall,
   count(*) filter(where nf>=2 and nr>=2 and fall_gap>rise_gap)::integer more_discount_after_rise,
   count(*) filter(where nf>=2 and nr>=2 and fall_gap=rise_gap)::integer ties,
   round(avg(fall_gap-rise_gap) filter(where nf>=2 and nr>=2)::numeric,4)::float8 mean_event_gap_difference
  from e`),
  db.unsafe(`select sampled_cohort,count(*)::integer n,
   round(percentile_cont(.5) within group(order by signed_minus_prior_indicator)::numeric,4)::float8 median_signed_gap,
   count(*) filter(where five_min_momentum is not null)::integer momentum_available
  from pi.rn1_maker_signed_creation_price_analysis where quote_status='confirmed'
  group by 1 order by 1`)
 ]);
 return {source:"historical_clob_prices_before_signer_declared_timestamp",
  coverage,regimes,periods,event_controls:controls[0]||{},cohort_comparison:sample,
  limitations:[
   "Prices-history reflects a retrospective API series, not an authenticated contemporaneous quote capture. Its timestamp is earlier than the declared order time but publication availability then is not independently established.",
   "Price indicator is neither the executable bid nor ask, spread, queue, or proof of maker placement.",
   "Only orders with confirmed executed fills are sampled; unexecuted orders are absent.",
   "The comparison is conditional on price availability and on transaction-level sampling; targeted multi-level and persistent cohorts are not representative.",
   "Only 13 events have at least two falling and two rising signed-order observations for within-event comparison; no causal impact or copy trading edge is established."
  ]};
}
