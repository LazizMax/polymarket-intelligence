// Authenticated read-only view of signed Maker order hashes recovered from public
// Polygon CTF Exchange V2 OrderFilled events. No signing keys or private orders.
export async function rn1OnchainOrdersReport(db:any){
 const [progress,summary,top,unmapped,phasePrice,phaseEvent]=await Promise.all([
  db.unsafe(`select status,from_block,to_block,next_block,chunks_done,
     chain_logs_seen,fills_verified,tx_confirmed,tx_unmatched,
     error_attempts,last_error,last_success_at::text last_success_at,
     round(100.0*(next_block-from_block)/nullif(to_block-from_block+1,0),2)::float8 block_progress_pct,
     (select count(*)::integer from pi.rn1_maker_historical_fills where role='maker') archive_maker_fills,
     (select count(*)::integer from pi.rn1_maker_historical_fills where maker_order_hash is not null) actual_order_fills
     from pi.rn1_maker_chain_scan_state where singleton=true`),
  db.unsafe(`select count(*)::integer signed_orders,
     coalesce(sum(verified_fills),0)::integer mapped_fills,
     count(*) filter(where transaction_count>1)::integer orders_multiple_transactions,
     count(*) filter(where execution_price_count>1)::integer orders_multiple_execution_prices,
     count(*) filter(where observed_fill_span_seconds>=60)::integer observed_span_at_least_1min,
     count(*) filter(where observed_fill_span_seconds>=3600)::integer observed_span_at_least_1hour,
     max(observed_fill_span_seconds)::bigint max_observed_span_seconds,
     round(percentile_cont(.5) within group(order by observed_fill_span_seconds)
       filter(where transaction_count>1)::numeric,2)::float8 median_repeated_order_span_seconds
   from pi.rn1_maker_signed_orders`),
  db.unsafe(`select order_hash,event_slug,verified_fills,transaction_count,execution_price_count,
    round(gross_notional,2)::float8 gross_notional,
    observed_fill_span_seconds,first_fill_at::text first_fill_at,last_fill_at::text last_fill_at
    from pi.rn1_maker_signed_orders
    where transaction_count>1
    order by transaction_count desc, gross_notional desc limit 8`),
  db.unsafe(`select
    (select count(*)::integer from pi.rn1_maker_onchain_tx_audit where status='ambiguous') ambiguous_transactions,
    (select count(*)::integer from pi.rn1_maker_ambiguous_order_events) onchain_orders_not_fingerprint_mapped,
    (select count(*)::integer from pi.rn1_maker_historical_fills f where f.role='maker' and f.transaction_hash in(
      select transaction_hash from pi.rn1_maker_onchain_tx_audit where status='ambiguous')) unmapped_fills_in_ambiguous_txs`),
  db.unsafe(`with ranked as (
   select maker_order_hash,event_slug,trade_at,transaction_hash,maker_order_log_index,fingerprint,momentum_5m,
   row_number() over(partition by maker_order_hash order by trade_at,transaction_hash,maker_order_log_index,fingerprint) seq
   from pi.rn1_maker_historical_fills where role='maker' and maker_order_hash is not null
  )
  select case when abs(momentum_5m)>.01 then 'volatile' else 'calm' end regime,
   count(*)::integer fills,count(*) filter(where seq=1)::integer first_observed_fills,
   count(*) filter(where seq>1)::integer repeat_fills,
   round(100.0*avg((seq=1)::integer),2)::float8 pct_first_observed,
   count(distinct event_slug)::integer events
  from ranked where momentum_5m is not null group by 1 order by 1`),
  db.unsafe(`with ranked as (
   select maker_order_hash,event_slug,trade_at,transaction_hash,maker_order_log_index,fingerprint,momentum_5m,
   row_number() over(partition by maker_order_hash order by trade_at,transaction_hash,maker_order_log_index,fingerprint) seq
   from pi.rn1_maker_historical_fills where role='maker' and maker_order_hash is not null
  ), per_event as (
   select event_slug,
    count(*) filter(where abs(momentum_5m)>.01) nvolatile,
    count(*) filter(where abs(momentum_5m)<=.01) ncalm,
    avg((seq=1)::integer) filter(where abs(momentum_5m)>.01) first_volatile,
    avg((seq=1)::integer) filter(where abs(momentum_5m)<=.01) first_calm
   from ranked where momentum_5m is not null group by event_slug
  )
  select count(*)::integer events,
   count(*) filter(where nvolatile>=5 and ncalm>=5)::integer comparable_events,
   count(*) filter(where nvolatile>=5 and ncalm>=5 and first_volatile>first_calm)::integer more_first_volatile,
   count(*) filter(where nvolatile>=5 and ncalm>=5 and first_volatile<first_calm)::integer more_first_calm,
   round(avg(first_volatile-first_calm) filter(where nvolatile>=5 and ncalm>=5)::numeric,4)::float8 mean_event_diff
  from per_event`)
 ]);
 return {status:"observed_onchain_orders",scan:progress[0]||{},summary:summary[0]||{},
    examples:top,unmapped:unmapped[0]||{},price_phase:phasePrice,price_phase_event:phaseEvent[0]||{},
    limitations:[
     "Order hash is a signed on-chain order identifier, not an order creation timestamp.",
     "Only orders with at least one executed fill can be observed; unfilled/cancelled orders remain invisible.",
     "The first-to-last fill interval is a lower bound on observable active execution time, not full resting duration.",
     "Sub-cent raw price drift under one signed order hash is numerical precision, not proof of repricing.",
     "First observed fill is not an order creation event. The small matched-price cohort cannot establish placement decisions.",
     "Scanned block coverage is bounded to the archived 80,000 fills; no copy-trading ROI is inferred."
    ]};
}

export async function rn1OriginalOrderCalldataReport(db:any){
 const [progress,cohorts,ladder,age,examples,pairEvidence,pairedByTx,precision,ladderStepsByPeriod]=await Promise.all([
 db.unsafe(`select cohort,status,count(*)::integer transactions,
  coalesce(sum(matched_orders),0)::integer matched_orders
  from pi.rn1_maker_calldata_sample_txs group by cohort,status order by cohort,status`),
 db.unsafe(`select sampled_cohort,count(*)::integer orders,count(distinct event_slug)::integer events,
  round(percentile_cont(.5) within group(order by signed_order_shares)::numeric,2)::float8 signed_shares_median,
  round(percentile_cont(.5) within group(order by filled_shares)::numeric,2)::float8 filled_shares_median,
  round(percentile_cont(.5) within group(order by age_to_first_fill_seconds)::numeric,2)::float8 age_median_s,
  round(percentile_cont(.9) within group(order by age_to_first_fill_seconds)::numeric,2)::float8 age_p90_s,
  round(percentile_cont(.5) within group(order by observed_fill_ratio)::numeric,4)::float8 fill_ratio_median,
  round(100.0*avg((observed_fill_ratio>=.999)::int)::numeric,2)::float8 pct_near_full,
  round(100.0*avg((observed_fill_ratio<.5)::int)::numeric,2)::float8 pct_under_half
  from pi.rn1_maker_calldata_execution_analysis group by sampled_cohort order by sampled_cohort`),
 db.unsafe(`with creation_batches as (
  select a.source_transaction_hash,c.token_id,a.declared_created_ms,
   count(*) signed_orders,count(distinct round(a.signed_price,3)) levels,
   min(a.signed_order_shares) min_size,max(a.signed_order_shares) max_size,
   max(a.signed_price)-min(a.signed_price) price_width
  from pi.rn1_maker_calldata_execution_analysis a
   join pi.rn1_maker_calldata_signed_orders c using(order_hash)
  where a.sampled_cohort='multi_level'
  group by 1,2,3
 )
 select count(*)::integer timestamp_groups,
   count(*) filter(where levels>=2)::integer simultaneous_price_groups,
   count(*) filter(where levels>=3)::integer groups_three_or_more_levels,
   count(*) filter(where levels>=2 and max_size-min_size<=.01)::integer identical_share_ladders,
   round(percentile_cont(.5) within group(order by price_width) filter(where levels>=2)::numeric,4)::float8 median_price_width
 from creation_batches`),
 db.unsafe(`select case when age_to_first_fill_seconds<1 then '<1s'
   when age_to_first_fill_seconds<5 then '1-5s'
   when age_to_first_fill_seconds<30 then '5-30s'
   when age_to_first_fill_seconds<120 then '30s-2min'
   when age_to_first_fill_seconds<600 then '2-10min' else '10min+' end age_band,
   sampled_cohort,count(*)::integer orders
   from pi.rn1_maker_calldata_execution_analysis
   group by 1,2 order by sampled_cohort,1`),
 db.unsafe(`select order_hash,event_slug,sampled_cohort,
  round(signed_order_shares,3)::float8 signed_shares,
  round(filled_shares,3)::float8 observed_filled_shares,
  round(100*observed_fill_ratio,2)::float8 observed_fill_pct,
  round(signed_price,4)::float8 price,
  round(age_to_first_fill_seconds,2)::float8 signed_to_first_fill_seconds,
  declared_created_at::text declared_created_at,
  first_fill_at::text first_fill_at
  from pi.rn1_maker_calldata_execution_analysis
  where sampled_cohort='random_tx'
  order by age_to_first_fill_seconds desc limit 6`),
 db.unsafe(`with pairs as (
 select a.source_transaction_hash,a.token_id,
  a.declared_created_ms=b.declared_created_ms same_ms,
  (abs(a.signed_receive_shares-b.signed_receive_shares)<=10000)::integer equal_qty
 from pi.rn1_maker_calldata_signed_orders a
 join pi.rn1_maker_calldata_signed_orders b
 on a.source_transaction_hash=b.source_transaction_hash and a.token_id=b.token_id
 and a.order_hash<b.order_hash
 where a.sampled_cohort='multi_level' and b.sampled_cohort='multi_level'
  and abs(a.signed_price-b.signed_price)>=.005
 )
 select same_ms,count(*)::integer pairs,sum(equal_qty)::integer equal_qty_pairs,
 round(100.0*avg(equal_qty),2)::float8 pct_equal_qty
 from pairs group by 1 order by 1`),
 db.unsafe(`with pairs as (
 select a.source_transaction_hash,
 a.declared_created_ms=b.declared_created_ms same_ms,
 (abs(a.signed_receive_shares-b.signed_receive_shares)<=10000)::integer equal_qty
 from pi.rn1_maker_calldata_signed_orders a
 join pi.rn1_maker_calldata_signed_orders b
 on a.source_transaction_hash=b.source_transaction_hash and a.token_id=b.token_id
 and a.order_hash<b.order_hash
 where a.sampled_cohort='multi_level' and b.sampled_cohort='multi_level'
  and abs(a.signed_price-b.signed_price)>=.005
 ), per_tx as (
 select source_transaction_hash,
 count(*) filter(where same_ms) same_n,count(*) filter(where not same_ms) diff_n,
 avg(equal_qty) filter(where same_ms) same_rate,
 avg(equal_qty) filter(where not same_ms) diff_rate
 from pairs group by 1
 )
 select count(*) filter(where same_n>0 and diff_n>0)::integer comparable_txs,
 count(*) filter(where same_n>0 and diff_n>0 and same_rate>diff_rate)::integer same_more,
 count(*) filter(where same_n>0 and diff_n>0 and same_rate<diff_rate)::integer different_more,
 count(*) filter(where same_n>0 and diff_n>0 and same_rate=diff_rate)::integer ties
 from per_tx`),
 db.unsafe(`select count(*)::integer signed_orders,
  count(*) filter(where mod(signed_receive_shares,1000000)=0)::integer integer_token_orders,
  count(*) filter(where mod(signed_buy_amount,1000000)=0)::integer integer_usdc_orders,
  count(*) filter(where mod(declared_created_ms,1000)<>0)::integer subsecond_timestamps,
  count(*) filter(where cryptographic_match)::integer cryptographically_verified
  from pi.rn1_maker_calldata_signed_orders`),
 db.unsafe(`with levels as (
  select source_transaction_hash,token_id,declared_created_ms,
   round(signed_price,3) px
  from pi.rn1_maker_calldata_signed_orders where sampled_cohort='multi_level'
  group by 1,2,3,4
 ), gaps as (
  select declared_created_ms,
  px-lag(px) over(partition by source_transaction_hash,token_id,declared_created_ms order by px) gap
  from levels
 )
 select case when to_timestamp(declared_created_ms/1000.0)
  <'2026-11-09 20:39:27+00'::timestamptz then 'older' else 'recent' end period,
  count(*)::integer adjacent_steps,
  count(*) filter(where abs(gap-.01)<.0001)::integer one_cent_steps,
  round(100.0*avg((abs(gap-.01)<.0001)::int),2)::float8 pct_one_cent
  from gaps where gap is not null group by 1 order by 1`)
 ]);
 return {source:"cryptographic_eip712_calldata_verified",progress,cohorts,
  ladder:ladder[0]||{},age_distribution:age,examples,pair_evidence:pairEvidence,
  paired_transactions:pairedByTx[0]||{},precision:precision[0]||{},
  ladder_steps_by_period:ladderStepsByPeriod,
  limitations:[
   "The Order.timestamp is the signer-declared millisecond time; posting to the CLOB and cancellation times are not observable.",
   "The signed BUY takerAmount is the full requested token quantity; a fill can be partial.",
   "This is a bounded, transaction-selected sample. The multi-level and persistent cohorts are deliberately oversampled.",
   "Observed fill ratio is a lower-bound because only archived fills within this window are included.",
   "Identical signed timestamps and prices in the same Polygon match support batch order creation, but not simultaneous CLOB placement.",
   "No orderbook queue, fees, counterfactual outcomes or profitability is inferred."
  ]};
}

export async function rn1SignedOrderDetail(db:any,body:any){
 const orderHash=String(body?.order_hash||"").toLowerCase();
 if(!/^0x[0-9a-f]{64}$/.test(orderHash))return {error:"Identifiant d'ordre invalide"};
 const orders=await db.unsafe(`select order_hash,event_slug,market_key,token_id,
   verified_fills,transaction_count,execution_price_count,
   round(filled_shares,6)::float8 filled_shares,
   round(gross_notional,6)::float8 gross_notional,
   round(min_execution_price,6)::float8 min_price,
   round(max_execution_price,6)::float8 max_price,
   first_fill_at::text first_fill_at,last_fill_at::text last_fill_at,
   observed_fill_span_seconds
   from pi.rn1_maker_signed_orders where order_hash=$1`,[orderHash]);
 if(orders.length!==1)return {error:"Ordre signé non présent dans la cohorte vérifiée"};
 const fills=await db.unsafe(`select transaction_hash,maker_order_log_index log_index,
   trade_at::text executed_at,round(price,8)::float8 fill_price,
   round(shares,6)::float8 shares,round(price*shares,6)::float8 notional
   from pi.rn1_maker_historical_fills where maker_order_hash=$1 and role='maker'
   order by trade_at,maker_order_log_index,transaction_hash limit 150`,[orderHash]);
 const original=await db.unsafe(`select declared_created_ms,
   to_timestamp(declared_created_ms/1000.0)::text declared_created_at,
   round(signed_buy_amount/1000000,3)::float8 signed_usdc,
   round(signed_receive_shares/1000000,3)::float8 signed_shares,
   round(signed_price,6)::float8 signed_price,sampled_cohort
   from pi.rn1_maker_calldata_signed_orders where order_hash=$1`,[orderHash]);
 return {status:"confirmed_onchain",order:orders[0],original_order:original[0]||null,fills,limit:150,
   disclaimer:"Execution events only: creation, cancellations, remaining unfilled quantity and order-book queue are unknown."};
}
