// Authenticated forensic replay of immutable RN1 archives.
// The ledger replays trades, MERGE and outcome-indexed REDEEM events in time order,
// and separately records whether inventory is unresolved. This is not a full
// wallet ledger: fees, transfers, SPLIT and pre-existing holdings are unverified.
export async function rn1LedgerPilotReport(db:any){
 const [summary,marketList]=await Promise.all([
 db.unsafe(`select count(*)::integer pilot_markets,
  count(*) filter(where trade_aggregate_reconciled and
   activity_aggregate_reconciled and intermediate_inventory_nonnegative)::integer source_reconciled,
  count(*) filter(where evidence_status='gross_cash_balanced_dust')::integer balanced_or_dust,
  count(*) filter(where evidence_status='open_or_unexplained_inventory')::integer unresolved_inventory,
  sum(source_trade_fills)::integer confirmed_trades,
  sum(verified_archive_pages)::integer sha_verified_page_reads,
  round(sum(gross_cash_net) filter(where evidence_status='gross_cash_balanced_dust'),5)::float8 balanced_gross_cash_net
  from pi.rn1_ledger_pilot_audit`),
 db.unsafe(`select market_key,title,first_event_at::text first_event_at,
  last_event_at::text last_event_at,
  source_trade_fills,merge_events,redeem_events,verified_archive_pages,
  round(trade_spend,6)::float8 trade_spend,
  round(trade_proceeds,6)::float8 trade_proceeds,
  round(merge_cash_in,6)::float8 merge_cash_in,
  round(redeem_cash_in,6)::float8 redeem_cash_in,
  round(gross_cash_net,6)::float8 gross_cash_net,
  round(residual_outcome0,6)::float8 residual_outcome0,
  round(residual_outcome1,6)::float8 residual_outcome1,
  trade_aggregate_reconciled,activity_aggregate_reconciled,
  intermediate_inventory_nonnegative,evidence_status,
  jsonb_array_length(timeline)::integer timeline_events
  from pi.rn1_ledger_pilot_audit order by title`)
 ]);
 return {status:"chronological_pilot_replayed",summary:summary[0]||{},markets:marketList,
 evidence:"immutable_storage_gzip_SHA256_verified_and_trades_activity_aggregates_reconciled",
 limitations:[
  "The trades and economic activity rows come from archived Data API views; they are not an independently decoded onchain transfer ledger.",
  "MERGE burns an equal amount of outcome 0 and outcome 1 shares. REDEEM burns the activity outcome_index and yields the activity usdc_size; losing redemptions may pay zero.",
  "Zero or dust executed-flow inventory is not proof of zero real wallet holdings: incoming/outgoing transfers, splits and opening balances are not fully reconstructed.",
  "Gross net cash flow is buys/sells plus MERGE/REDEEM proceeds with no verified execution fees, rebates or transaction costs; not audited net ROI.",
  "A market with residual inventory has an unresolved cost basis and must not be assigned realized profit/loss from gross cash alone.",
  "The pilot has three deliberately selected historical markets and cannot estimate RN1 aggregate profitability."
 ]};
}
export async function rn1LedgerPilotDetail(db:any,body:any){
 const market=String(body?.market_key||"").toLowerCase();
 if(!/^0x[0-9a-f]{64}$/.test(market))return {status:"invalid_market_key"};
 const rows=await db.unsafe(`select market_key,title,evidence_status,
  round(gross_cash_net,6)::float8 gross_cash_net,
  round(residual_outcome0,6)::float8 residual_outcome0,
  round(residual_outcome1,6)::float8 residual_outcome1,
  trade_aggregate_reconciled,activity_aggregate_reconciled,
  intermediate_inventory_nonnegative,timeline
  from pi.rn1_ledger_pilot_audit where market_key=$1`,[market]);
 if(!rows.length)return {status:"not_a_pilot_market"};
 return {status:"ok",...rows[0]};
}
