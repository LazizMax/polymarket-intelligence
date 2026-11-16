// Authenticated read-only view of signed Maker order hashes recovered from public
// Polygon CTF Exchange V2 OrderFilled events. No signing keys or private orders.
export async function rn1OnchainOrdersReport(db:any){
 const [progress,summary,top,unmapped]=await Promise.all([
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
      select transaction_hash from pi.rn1_maker_onchain_tx_audit where status='ambiguous')) unmapped_fills_in_ambiguous_txs`)
 ]);
 return {status:"observed_onchain_orders",scan:progress[0]||{},summary:summary[0]||{},
    examples:top,unmapped:unmapped[0]||{},
    limitations:[
     "Order hash is a signed on-chain order identifier, not an order creation timestamp.",
     "Only orders with at least one executed fill can be observed; unfilled/cancelled orders remain invisible.",
     "The first-to-last fill interval is a lower bound on observable active execution time, not full resting duration.",
     "A single signed order may have multiple execution prices; execution price changes do not prove requoting.",
     "Scanned block coverage is bounded to the archived 80,000 fills; no copy-trading ROI is inferred."
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
 return {status:"confirmed_onchain",order:orders[0],fills,limit:150,
   disclaimer:"Execution events only: creation, cancellations, remaining unfilled quantity and order-book queue are unknown."};
}
