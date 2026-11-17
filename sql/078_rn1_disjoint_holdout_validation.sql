-- RN1 independent external validation, 2026-11-17. Only aggregate snapshots
-- are persisted. Underlying 531 multi-price and 392 single-order transactions
-- were validated via READ-ONLY Polygon EIP-712 RPC, excluding all previously
-- decoded source transactions/order hashes.
create table if not exists pi.rn1_holdout_ladder_validation (
 cohort text primary key check(cohort in('all','older','recent')),
 tested_transactions integer not null,verified_transactions integer not null,
 failed_transactions integer not null,signed_orders integer not null,
 integer_share_orders integer not null,integer_usdc_orders integer not null,
 same_ms_grid_groups integer not null,equal_size_grid_groups integer not null,
 adjacent_price_steps integer not null,one_cent_steps integer not null,
 same_ms_pairs integer not null,same_ms_equal_qty_pairs integer not null,
 different_ms_pairs integer not null,different_ms_equal_qty_pairs integer not null,
 hash_dedup_exclusion text not null,updated_at timestamptz not null default now());
create table if not exists pi.rn1_holdout_price_validation (
 period text not null check(period in('all','older','recent')),
 regime text not null check(regime in('all','fall','rise','stable','unknown')),
 n integer not null,with_momentum integer not null,
 median_signed_gap numeric,mean_signed_gap numeric,pct_below_half_point numeric,
 quote_age_median_seconds numeric,recent_30s_n integer not null,
 recent_30s_median_gap numeric,
 last_verified_at timestamptz not null default now(),
 primary key(period,regime));
create table if not exists pi.rn1_holdout_price_controls (
 singleton boolean primary key default true check(singleton),
 selected_transactions integer not null,validated_prices integer not null,
 missing_prices integer not null,decoding_errors integer not null,
 valid_momentum integer not null,validated_integer_shares integer not null,
 total_events integer not null,comparable_events_min1 integer not null,
 comparable_events_min2 integer not null,
 events_more_discount_after_fall integer not null,
 events_more_discount_after_rise integer not null,event_ties integer not null,
 mean_event_gap_difference numeric,verified_at timestamptz not null default now());
alter table pi.rn1_holdout_ladder_validation enable row level security;
alter table pi.rn1_holdout_price_validation enable row level security;
alter table pi.rn1_holdout_price_controls enable row level security;
revoke all on pi.rn1_holdout_ladder_validation,pi.rn1_holdout_price_validation,pi.rn1_holdout_price_controls from anon,authenticated;
-- Snapshots below were generated only after reconciling ALL study RPC calls.
insert into pi.rn1_holdout_ladder_validation
(cohort,tested_transactions,verified_transactions,failed_transactions,signed_orders,
 integer_share_orders,integer_usdc_orders,same_ms_grid_groups,equal_size_grid_groups,
 adjacent_price_steps,one_cent_steps,same_ms_pairs,same_ms_equal_qty_pairs,
 different_ms_pairs,different_ms_equal_qty_pairs,hash_dedup_exclusion)
select * from jsonb_to_recordset('[{"cohort":"all","tested_transactions":531,"verified_transactions":531,"failed_transactions":0,"signed_orders":1289,"integer_share_orders":1289,"integer_usdc_orders":81,"same_ms_grid_groups":281,"equal_size_grid_groups":196,"adjacent_price_steps":299,"one_cent_steps":278,"same_ms_pairs":352,"same_ms_equal_qty_pairs":261,"different_ms_pairs":509,"different_ms_equal_qty_pairs":136,"hash_dedup_exclusion":"exclude all prior calldata sample transactions and any transaction containing previously decoded orderHash"},{"cohort":"older","tested_transactions":278,"verified_transactions":278,"failed_transactions":0,"signed_orders":681,"integer_share_orders":681,"integer_usdc_orders":40,"same_ms_grid_groups":143,"equal_size_grid_groups":98,"adjacent_price_steps":157,"one_cent_steps":147,"same_ms_pairs":195,"same_ms_equal_qty_pairs":141,"different_ms_pairs":281,"different_ms_equal_qty_pairs":73,"hash_dedup_exclusion":"exclude all prior calldata sample transactions and any transaction containing previously decoded orderHash"},{"cohort":"recent","tested_transactions":253,"verified_transactions":253,"failed_transactions":0,"signed_orders":608,"integer_share_orders":608,"integer_usdc_orders":41,"same_ms_grid_groups":138,"equal_size_grid_groups":98,"adjacent_price_steps":142,"one_cent_steps":131,"same_ms_pairs":157,"same_ms_equal_qty_pairs":120,"different_ms_pairs":228,"different_ms_equal_qty_pairs":63,"hash_dedup_exclusion":"exclude all prior calldata sample transactions and any transaction containing previously decoded orderHash"}]'::jsonb)
 as a(cohort text,tested_transactions int,verified_transactions int,failed_transactions int,signed_orders int,
 integer_share_orders int,integer_usdc_orders int,same_ms_grid_groups int,equal_size_grid_groups int,
 adjacent_price_steps int,one_cent_steps int,same_ms_pairs int,same_ms_equal_qty_pairs int,
 different_ms_pairs int,different_ms_equal_qty_pairs int,hash_dedup_exclusion text)
on conflict(cohort) do nothing;
insert into pi.rn1_holdout_price_validation
(period,regime,n,with_momentum,median_signed_gap,mean_signed_gap,
 pct_below_half_point,quote_age_median_seconds,recent_30s_n,recent_30s_median_gap)
select * from jsonb_to_recordset('[{"period":"all","regime":"all","n":376,"with_momentum":363,"median_signed_gap":"-0.00500","mean_signed_gap":"-0.00949","pct_below_half_point":"50.00","quote_age_median_seconds":"31.50","recent_30s_n":182,"recent_30s_median_gap":"-0.00475"},{"period":"all","regime":"fall","n":129,"with_momentum":129,"median_signed_gap":"-0.00550","mean_signed_gap":"-0.01503","pct_below_half_point":"58.14","quote_age_median_seconds":"30.00","recent_30s_n":65,"recent_30s_median_gap":"-0.00350"},{"period":"all","regime":"rise","n":162,"with_momentum":162,"median_signed_gap":"-0.00500","mean_signed_gap":"-0.00595","pct_below_half_point":"50.00","quote_age_median_seconds":"29.50","recent_30s_n":82,"recent_30s_median_gap":"-0.00500"},{"period":"all","regime":"stable","n":72,"with_momentum":72,"median_signed_gap":"-0.00225","mean_signed_gap":"-0.00890","pct_below_half_point":"37.50","quote_age_median_seconds":"37.00","recent_30s_n":32,"recent_30s_median_gap":"-0.00150"},{"period":"all","regime":"unknown","n":13,"with_momentum":0,"median_signed_gap":"0.00000","mean_signed_gap":"-0.00200","pct_below_half_point":"38.46","quote_age_median_seconds":"42.00","recent_30s_n":3,"recent_30s_median_gap":"0.00000"},{"period":"older","regime":"all","n":198,"with_momentum":197,"median_signed_gap":"-0.00500","mean_signed_gap":"-0.01117","pct_below_half_point":"51.01","quote_age_median_seconds":"30.00","recent_30s_n":102,"recent_30s_median_gap":"-0.00500"},{"period":"older","regime":"fall","n":73,"with_momentum":73,"median_signed_gap":"-0.00550","mean_signed_gap":"-0.01360","pct_below_half_point":"60.27","quote_age_median_seconds":"30.00","recent_30s_n":38,"recent_30s_median_gap":"-0.00500"},{"period":"older","regime":"rise","n":88,"with_momentum":88,"median_signed_gap":"-0.00500","mean_signed_gap":"-0.00709","pct_below_half_point":"51.14","quote_age_median_seconds":"28.50","recent_30s_n":46,"recent_30s_median_gap":"-0.00500"},{"period":"older","regime":"stable","n":36,"with_momentum":36,"median_signed_gap":"-0.00175","mean_signed_gap":"-0.01597","pct_below_half_point":"30.56","quote_age_median_seconds":"36.50","recent_30s_n":17,"recent_30s_median_gap":"-0.00150"},{"period":"older","regime":"unknown","n":1,"with_momentum":0,"median_signed_gap":"-0.02000","mean_signed_gap":"-0.02000","pct_below_half_point":"100.00","quote_age_median_seconds":"22.00","recent_30s_n":1,"recent_30s_median_gap":"-0.02000"},{"period":"recent","regime":"all","n":178,"with_momentum":166,"median_signed_gap":"-0.00500","mean_signed_gap":"-0.00763","pct_below_half_point":"48.88","quote_age_median_seconds":"33.00","recent_30s_n":80,"recent_30s_median_gap":"-0.00075"},{"period":"recent","regime":"fall","n":56,"with_momentum":56,"median_signed_gap":"-0.01000","mean_signed_gap":"-0.01688","pct_below_half_point":"55.36","quote_age_median_seconds":"31.50","recent_30s_n":27,"recent_30s_median_gap":"0.00000"},{"period":"recent","regime":"rise","n":74,"with_momentum":74,"median_signed_gap":"0.00250","mean_signed_gap":"-0.00460","pct_below_half_point":"48.65","quote_age_median_seconds":"31.00","recent_30s_n":36,"recent_30s_median_gap":"-0.00500"},{"period":"recent","regime":"stable","n":36,"with_momentum":36,"median_signed_gap":"-0.00350","mean_signed_gap":"-0.00182","pct_below_half_point":"44.44","quote_age_median_seconds":"37.00","recent_30s_n":15,"recent_30s_median_gap":"-0.00150"},{"period":"recent","regime":"unknown","n":12,"with_momentum":0,"median_signed_gap":"0.00250","mean_signed_gap":"-0.00050","pct_below_half_point":"33.33","quote_age_median_seconds":"42.50","recent_30s_n":2,"recent_30s_median_gap":"0.00250"}]'::jsonb)
 as a(period text,regime text,n int,with_momentum int,median_signed_gap numeric,mean_signed_gap numeric,
 pct_below_half_point numeric,quote_age_median_seconds numeric,recent_30s_n int,recent_30s_median_gap numeric)
on conflict(period,regime) do nothing;
insert into pi.rn1_holdout_price_controls
(singleton,selected_transactions,validated_prices,missing_prices,decoding_errors,
 valid_momentum,validated_integer_shares,total_events,comparable_events_min1,
 comparable_events_min2,events_more_discount_after_fall,events_more_discount_after_rise,
 event_ties,mean_event_gap_difference)
select true,selected_transactions,validated_prices,missing_prices,decoding_errors,
 valid_momentum,validated_integer_shares,total_events,comparable_events_min1,
 comparable_events_min2,events_more_discount_after_fall,events_more_discount_after_rise,
 event_ties,mean_event_gap_difference
from jsonb_to_recordset('[{"selected_transactions":392,"validated_prices":376,"missing_prices":16,"decoding_errors":0,"valid_momentum":363,"validated_integer_shares":376,"total_events":295,"comparable_events_min1":22,"comparable_events_min2":1,"events_more_discount_after_fall":11,"events_more_discount_after_rise":10,"event_ties":1,"mean_event_gap_difference":"0.00234"}]'::jsonb)
 as c(selected_transactions int,validated_prices int,missing_prices int,decoding_errors int,
 valid_momentum int,validated_integer_shares int,total_events int,comparable_events_min1 int,
 comparable_events_min2 int,events_more_discount_after_fall int,
 events_more_discount_after_rise int,event_ties int,mean_event_gap_difference numeric)
on conflict(singleton) do nothing;
