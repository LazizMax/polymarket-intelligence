// RN1 economic audit: strictly distinguishes source-reported PnL,
 // limited realized-position sample, and counterfactual YES/NO pairing.
 // No new raw trade storage or claim of realized arb profit.
const RN1="0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
export async function rn1EconomicReconstruction(db:any){
 const [markets,flows,closed,snapshots,availability]=await Promise.all([
 db.unsafe(`with m as (
 select market_key,min_trade_at,max_trade_at,fills,buy_fills,sell_fills,
 buy0_shares,buy1_shares,sell0_shares,sell1_shares,
 buy0_cost,buy1_cost,sell0_proceeds,sell1_proceeds,
 least(buy0_shares,buy1_shares) matched_possible_shares,
 case when buy0_shares>0 and buy1_shares>0 then
  buy0_cost/nullif(buy0_shares,0)+buy1_cost/nullif(buy1_shares,0) end pair_avg_cost,
 case when buy0_shares>0 and buy1_shares>0 then
  least(buy0_shares,buy1_shares)*
  (1-buy0_cost/nullif(buy0_shares,0)-buy1_cost/nullif(buy1_shares,0)) end possible_pair_margin
 from pi.rn1_full_market_metrics where wallet=$1
 )
 select count(*)::integer markets,
 coalesce(sum(fills),0)::bigint fills,
 coalesce(sum(buy_fills),0)::bigint buy_fills,
 coalesce(sum(sell_fills),0)::bigint sell_fills,
 count(*) filter(where buy0_shares>0 and buy1_shares>0)::integer both_sides_bought,
 count(*) filter(where buy0_shares>0 and buy1_shares>0 and pair_avg_cost<1)::integer pair_price_below_one,
 count(*) filter(where buy0_shares>0 and buy1_shares>0 and pair_avg_cost>=1)::integer pair_price_at_or_above_one,
 count(*) filter(where sell0_shares+sell1_shares>0)::integer markets_with_sell,
 round(coalesce(sum(buy0_cost+buy1_cost),0),2)::float8 gross_buy_spend,
 round(coalesce(sum(sell0_proceeds+sell1_proceeds),0),2)::float8 gross_sell_proceeds,
 round(coalesce(sum(matched_possible_shares),0),2)::float8 potential_matched_shares,
 round(coalesce(sum(matched_possible_shares*pair_avg_cost),0),2)::float8 hypothetical_paired_cost,
 round(coalesce(sum(possible_pair_margin),0),2)::float8 hypothetical_gross_pair_margin,
 round(coalesce(sum(possible_pair_margin) filter(where possible_pair_margin>0),0),2)::float8 positive_gross_pair_proxy,
 round(coalesce(sum(possible_pair_margin) filter(where possible_pair_margin<0),0),2)::float8 negative_gross_pair_proxy,
 round(percentile_cont(.5) within group(order by pair_avg_cost)
  filter(where pair_avg_cost is not null)::numeric,4)::float8 median_pair_average_cost,
 round(coalesce(sum(greatest(buy0_shares-buy1_shares,0)),0),2)::float8 imbalance_outcome0_shares,
 round(coalesce(sum(greatest(buy1_shares-buy0_shares,0)),0),2)::float8 imbalance_outcome1_shares,
 min(min_trade_at)::text first_trade_at,max(max_trade_at)::text last_trade_at
 from m`,[RN1]),
 db.unsafe(`select kind,sum(events)::bigint reported_events,
   round(sum(reported_usdc_size),2)::float8 reported_usdc_size,
   min(min_event_at)::text first_at,max(max_event_at)::text last_at
   from pi.rn1_full_activity_metrics where wallet=$1
   group by kind order by kind`,[RN1]),
 db.unsafe(`select count(*)::integer positions,
   count(*) filter(where valid_cost)::integer valid_cost_positions,
   count(*) filter(where not valid_cost)::integer invalid_cost_positions,
   round(coalesce(sum(estimated_entry_cost_usdc) filter(where valid_cost),0),2)::float8 entry_cost,
   round(coalesce(sum(realized_pnl_usdc) filter(where valid_cost),0),2)::float8 estimated_realized_pnl,
   round(100.0*sum(realized_pnl_usdc) filter(where valid_cost)/
     nullif(sum(estimated_entry_cost_usdc) filter(where valid_cost),0),4)::float8 cost_weighted_roi_pct,
   round(avg(estimated_roi_pct) filter(where valid_cost),2)::float8 unweighted_mean_roi_pct,
   count(*) filter(where valid_cost and realized_pnl_usdc>0)::integer win_positions,
   count(*) filter(where valid_cost and realized_pnl_usdc<0)::integer losing_positions,
   min(first_entry_at)::text earliest_entry_at,
   max(last_event_at)::text last_event_at,
   max(generation)::bigint latest_generation
   from pi.closed_position_roi where wallet=$1`,[RN1]),
 db.unsafe(`with ordered as (
 select day,source,completeness,realized_pnl_usdc,
  economic_pnl_usdc,position_pnl_usdc,
  lag(realized_pnl_usdc) over(order by day) prev_realized,
  lag(economic_pnl_usdc) over(order by day) prev_economic,
  lag(position_pnl_usdc) over(order by day) prev_position
 from pi.wallet_pnl_daily where wallet=$1
 )
 select day::text as day,source,completeness,
 round(realized_pnl_usdc,2)::float8 realized_snapshot,
 round(economic_pnl_usdc,2)::float8 economic_snapshot,
 round(position_pnl_usdc,2)::float8 position_snapshot,
 round(realized_pnl_usdc-prev_realized,2)::float8 reported_realized_delta,
 round(economic_pnl_usdc-prev_economic,2)::float8 reported_economic_delta,
 round(position_pnl_usdc-prev_position,2)::float8 reported_position_delta
 from ordered order by day desc limit 15`,[RN1]),
 db.unsafe(`select count(*)::integer pnl_snapshot_days,
  count(*) filter(where completeness='complete')::integer complete_days,
  count(*) filter(where completeness='partial')::integer partial_days,
  min(day)::text first_snapshot_day,max(day)::text last_snapshot_day
  from pi.wallet_pnl_daily where wallet=$1`,[RN1])
 ]);
 return {status:"estimated_and_proxy_only",wallet:RN1,
  markets:markets[0]||{},flows,closed_positions:closed[0]||{},
  pnl_snapshots:snapshots,pnl_coverage:availability[0]||{},
  evidence_labels:{
   market_counts:"archive_aggregates_observed",
   cost_of_complementary_outcomes:"counterfactual_lifetime_weighted_average_proxy",
   closed_positions:"limited_cost_model_estimate_not_full_ledger",
   pnl_snapshots:"provider_reported_cumulative_partial_not_verified_ledger",
   activity:"reported_event_amounts_not_net_cash_flow"
  },
  warnings:[
   "BUY/SELL counts include all public fills assigned to this RN1 wallet in the full-market aggregate; archive stops at its last collected timestamp.",
   "Pairing across a whole market uses lifetime average BUY prices and min(total YES, total NO); no ordering, actual simultaneous inventory, redemptions, fees, open residuals, or carry is reconstructed. The hypothetical margin is NOT realized profit.",
   "Provider PnL daily rows are cumulative snapshots; NEVER sum them. Changes between adjacent snapshots are snapshot differences, not necessarily realized trading daily profits.",
   "All source PnL snapshots are flagged partial. The closed_position_roi sample includes only the indexed generation/window and its ROI is model-estimated with incomplete or unverified fee basis.",
   "Activity MERGE/REDEEM/REWARD/REBATE reported_usdc_size are separately reported activity metrics, not a reconciled signed ledger or independently verified receipt balances.",
   "A fully verified PnL/ROI after fees requires a consistent per-market ledger of BUY, SELL, MERGE, REDEEM, SPLIT, fee and transfer cash flows plus beginning/ending inventories."
  ]};
}
