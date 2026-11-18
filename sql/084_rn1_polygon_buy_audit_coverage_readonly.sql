-- RN1 Polygon acquisition audit: read-only coverage report.
-- Scope fixed to the independently audited, settled eight-market panel.
-- NEVER compute PnL from sample debit vs full-panel receipts.
with panel as (
  select l.market_key,l.title,l.cohort,l.source_trade_fills,
         l.buy_spend,l.sell_proceeds,l.merge_in,l.redeem_in,l.gross_cash_net,
         s.direct_pusd_all_credits_matched
  from pi.rn1_ledger_holdout_audit l
  join pi.rn1_chain_settlement_audit s using(market_key)
), buys as (
  select market_key,count(*) audited_buy_txs,
         sum(observed_direct_pusd_debit) onchain_sample_debit,
         count(*) filter(where exact_collateral_debit and exact_share_receipt) exact_both_flows,
         count(*) filter(where not exact_collateral_debit or not exact_share_receipt) failed_both_flows
  from pi.rn1_chain_acquisition_sample group by market_key
)
select p.market_key,p.title,p.cohort,p.source_trade_fills,
       coalesce(b.audited_buy_txs,0) audited_buy_txs,
       p.source_trade_fills-coalesce(b.audited_buy_txs,0) unaudited_fills_upper_bound,
       round(100.0*coalesce(b.audited_buy_txs,0)/nullif(p.source_trade_fills,0),2) audited_tx_to_fill_ratio_pct,
       coalesce(b.exact_both_flows,0) exact_both_flows,
       coalesce(b.failed_both_flows,0) failed_both_flows,
       b.onchain_sample_debit,p.buy_spend archived_all_buy_cost,
       p.sell_proceeds+p.merge_in+p.redeem_in archived_all_inflows,
       p.gross_cash_net archived_gross_net_before_fees,
       p.direct_pusd_all_credits_matched,
       case when coalesce(b.audited_buy_txs,0) < p.source_trade_fills then 'INCOMPLETE_ACQUISITION_AUDIT'
            else 'CHECK_UNIQUE_TX_MAPPING_AND_NON_TRADE_TRANSFERS' end audit_status
from panel p left join buys b using(market_key)
order by p.market_key;
-- Audit counts are distinct sampled transactions, while source_trade_fills counts fills.
-- Therefore the difference is an *upper bound* on unaudited fills only if sampled txs
-- each map to unique fills; verify hash+market+token+side before using for coverage.
