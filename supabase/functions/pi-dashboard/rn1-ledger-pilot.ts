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

export async function rn1LedgerHoldoutReport(db:any){
 const [groups,markets,overall]=await Promise.all([
 db.unsafe(`select cohort,count(*)::int markets,
  count(*) filter(where source_fills_match and source_activity_match and inventory_nonnegative)::int source_verified,
  count(*) filter(where evidence_status='gross_cash_balanced_dust')::int balanced_or_dust,
  count(*) filter(where evidence_status='open_or_unexplained_inventory')::int unresolved,
  count(*) filter(where evidence_status='source_inconsistent' or evidence_status='intermediate_inventory_negative')::int invalid,
  sum(source_trade_fills)::int trades,sum(source_merge_events)::int merges,sum(source_redeem_events)::int redemptions,
  sum(verified_pages)::int sha_verified_page_reads,
  round(sum(gross_cash_net) filter(where evidence_status='gross_cash_balanced_dust'),3)::float8 balanced_gross_cash,
  round(sum(buy_spend) filter(where evidence_status='gross_cash_balanced_dust'),3)::float8 balanced_buy_spend
  from pi.rn1_ledger_holdout_audit group by cohort order by cohort`),
 db.unsafe(`select market_key,cohort,cohort_rank,title,
  source_trade_fills,source_merge_events,source_redeem_events,verified_pages,
  round(buy_spend,3)::float8 buy_spend,
  round(merge_in+redeem_in+sell_proceeds,3)::float8 gross_cash_in,
  round(gross_cash_net,3)::float8 gross_cash_net,
  round(terminal0,6)::float8 terminal0,round(terminal1,6)::float8 terminal1,
  source_fills_match,source_activity_match,inventory_nonnegative,evidence_status,
  jsonb_array_length(timeline)::int timeline_events
  from pi.rn1_ledger_holdout_audit order by cohort,cohort_rank`),
 db.unsafe(`select count(*)::int audited,
  count(*) filter(where source_fills_match and source_activity_match and inventory_nonnegative)::int verified,
  count(*) filter(where evidence_status='gross_cash_balanced_dust')::int balanced_or_dust,
  count(*) filter(where gross_cash_net>0 and evidence_status='gross_cash_balanced_dust')::int positive_balanced,
  count(*) filter(where gross_cash_net<0 and evidence_status='gross_cash_balanced_dust')::int negative_balanced,
  sum(verified_pages)::int sha_verified_page_reads,sum(source_trade_fills)::int trades,
  round(sum(gross_cash_net) filter(where evidence_status='gross_cash_balanced_dust'),3)::float8 balanced_cash_delta,
  round(sum(buy_spend) filter(where evidence_status='gross_cash_balanced_dust'),3)::float8 balanced_spend,
  round(100*sum(gross_cash_net) filter(where evidence_status='gross_cash_balanced_dust')/
   nullif(sum(buy_spend) filter(where evidence_status='gross_cash_balanced_dust'),0),3)::float8 selected_balanced_cash_pct
  from pi.rn1_ledger_holdout_audit`)
 ]);
 return {status:"stratified_holdout_complete",study_version:"rn1-independent-ledger-20261118-v1",
  groups,markets,summary:overall[0]||{},
  methodology:"Four deterministic SHA256-ordered markets in each of four economic-action cohorts (MERGE only, MERGE+REDEEM, REDEEM only, trades only). Source selection was frozen before archive replay; all 16 original immutable gzip archives were verified by SHA256.",
  limitations:[
    "Selection is random only within constrained September 2026 strata; not unbiased RN1 wallet population and not a return backtest.",
    "No transfers, opening holdings, splits, gas, fees or rebates independently reconciled.",
    "An unresolved inventory with a negative cash delta is not a realized loss.",
    "The combined gross cash flow of the eight terminal-balanced markets is NOT a measured net strategy return and is not generalizable.",
    "Seconds-level API timestamps do not always establish intra-second execution order."
  ]};
}
export async function rn1LedgerHoldoutDetail(db:any,body:any){
 const key=String(body?.market_key||"").toLowerCase();
 if(!/^0x[0-9a-f]{64}$/.test(key))return {status:"invalid_market_key"};
 const rows=await db.unsafe(`select market_key,cohort,title,evidence_status,
  round(gross_cash_net,6)::float8 gross_cash_net,
  round(terminal0,6)::float8 terminal0,round(terminal1,6)::float8 terminal1,
  source_fills_match,source_activity_match,inventory_nonnegative,timeline
  from pi.rn1_ledger_holdout_audit where market_key=$1`,[key]);
 return rows.length?{status:"ok",...rows[0]}:{status:"not_a_holdout_market"};
}

export async function rn1ChainSettlementReport(db:any){
 const [summary,markets]=await Promise.all([
 db.unsafe(`select count(*)::integer markets,
 sum(transaction_receipts)::integer receipts,
 sum(source_merge_lines)::integer merges_reported,
 sum(onchain_merge_unique)::integer merges_onchain,
 sum(source_redeem_lines)::integer redeemed_outcome_lines,
 sum(onchain_redeem_transfer_unique)::integer redeemed_transfers_onchain,
 sum(source_positive_redeem_lines)::integer positive_payout_lines,
 sum(onchain_positive_payout_unique)::integer positive_payouts_onchain,
 sum(other_wallet_same_market_payout_logs)::integer other_wallet_payout_logs_excluded,
 sum(directly_paid_gas_txs)::integer rn1_direct_gas_transactions,
 sum(involved_wallet_erc1155_events)::integer wallet_erc1155_transfer_events,
 sum(observed_splits_in_settlement_txs)::integer splits_observed_in_receipts,
 sum(direct_pusd_merge_credit_count)::integer p_usd_merge_receipts,
 sum(direct_pusd_redeem_credit_count)::integer p_usd_redeem_receipts,
 round(sum(direct_pusd_merge_credit),6)::float8 verified_merge_collateral_credit,
 round(sum(direct_pusd_redeem_credit),6)::float8 verified_redeem_collateral_credit,
 round(sum(direct_pusd_merge_credit+direct_pusd_redeem_credit),6)::float8 verified_total_collateral_credit,
 count(*) filter(where direct_pusd_all_credits_matched)::integer direct_collateral_verified_markets,
 count(*) filter(where fully_correlated)::integer verified_markets
 from pi.rn1_chain_settlement_audit`),
 db.unsafe(`select a.market_key,h.title,h.cohort,a.transaction_receipts,
 a.source_merge_lines,a.onchain_merge_unique,
 a.source_redeem_lines,a.onchain_redeem_transfer_unique,
 a.source_positive_redeem_lines,a.onchain_positive_payout_unique,
 a.other_wallet_same_market_payout_logs,
 a.directly_paid_gas_txs,a.involved_wallet_erc1155_events,
 a.observed_splits_in_settlement_txs,a.fully_correlated,
 a.direct_pusd_merge_credit_count,a.direct_pusd_redeem_credit_count,
 round(a.direct_pusd_merge_credit,6)::float8 direct_pusd_merge_credit,
 round(a.direct_pusd_redeem_credit,6)::float8 direct_pusd_redeem_credit,
 a.direct_pusd_all_credits_matched,
 a.audit_at::text audit_at
 from pi.rn1_chain_settlement_audit a
 join pi.rn1_ledger_holdout_audit h on h.market_key=a.market_key
 order by h.cohort,h.cohort_rank`)
 ]);
 return {status:"partial_onchain_evidence_confirmed",
 summary:summary[0]||{},markets,
 evidence:"polygon_ctf_events_erc1155_transfers_condition_and_exact_amounts",
 limitations:[
  "8 balanced September 2026 markets only, not the complete wallet.",
  "4 MERGE and 16 REDEEM source share movements each match a unique ERC1155 transfer out of RN1 for a source transaction. Same-market CTF event amounts also match but ERC1155 token IDs are not yet independently mapped to the outcome tokens in this study.",
  "8 positive CTF redemption payouts were found by transaction, market and exact amount; these were independently matched to exact pUSD Transfer mint events to RN1. The Gnosis contract redemption intermediate redeemer may be a router.",
  "148 other same-market payout logs from batch transactions were excluded; no total batch payout was attributed to RN1.",
  "12 settlement tx were paid by addresses other than RN1; this does not establish whether gas was reimbursed indirectly.",
  "Zero-payout redemption source records have matching ERC1155 withdrawals, but zero-value payout events cannot alone prove account-level entitlement.",
  "12 direct pUSD credits to RN1 were verified for the positive merge/redemption source events, but the full ERC20 acquisition cash-outflows, fee/rebate ledger, third-party transfers, gas reimbursements, and opening wallet balances remain unverified. No after-fees PnL/ROI is claimed."
 ]};
}
