-- RN1: eight prespecified September 2026 terminal-balanced markets.
-- Polygon eth_getTransactionReceipt and eth_getTransactionByHash, with CTF
-- PositionsMerge/PayoutRedemption decoded by condition_id, then ERC1155
-- TransferBatch decoded by wallet and exact amounts. Receipts often contain
-- OTHER wallets' payouts in the SAME market: NEVER SUM their payout logs.
-- No gas was directly paid by RN1 in the 12 settlement transactions sampled.
-- This does NOT exclude indirect gas reimbursement/fee/rebate.
create table if not exists pi.rn1_chain_settlement_audit(
 market_key text primary key references pi.rn1_ledger_holdout_audit(market_key),
 chain_probe_version text not null default 'ctf_receipt_condition_amount_erc1155_v1',
 transaction_receipts integer not null,
 source_merge_lines integer not null,
 onchain_merge_unique integer not null,
 source_redeem_lines integer not null,
 onchain_redeem_transfer_unique integer not null,
 source_positive_redeem_lines integer not null,
 onchain_positive_payout_unique integer not null,
 other_wallet_same_market_payout_logs integer not null,
 directly_paid_gas_txs integer not null,
 involved_wallet_erc1155_events integer not null,
 observed_splits_in_settlement_txs integer not null,
 fully_correlated boolean not null,
 source_response_id bigint not null,
 audit_at timestamptz not null default now()
);
alter table pi.rn1_chain_settlement_audit enable row level security;
revoke all on pi.rn1_chain_settlement_audit from anon,authenticated;
-- Source response ids are provenance pointers from the original project;
-- the compact numerical audit results are fully snapshotted here.
insert into pi.rn1_chain_settlement_audit
select * from jsonb_populate_recordset(null::pi.rn1_chain_settlement_audit,
'[{"audit_at":"2026-11-18T15:12:24.572428+00:00","market_key":"0x2cbd9e101c127565af3504f2122d3ba27e8b17f47f54906541ed18179c79fae1","fully_correlated":true,"source_merge_lines":0,"source_response_id":11020,"chain_probe_version":"ctf_receipt_condition_amount_erc1155_v1","source_redeem_lines":2,"onchain_merge_unique":0,"transaction_receipts":1,"directly_paid_gas_txs":0,"source_positive_redeem_lines":1,"involved_wallet_erc1155_events":1,"onchain_positive_payout_unique":1,"onchain_redeem_transfer_unique":2,"observed_splits_in_settlement_txs":0,"other_wallet_same_market_payout_logs":19},{"audit_at":"2026-11-18T15:12:24.572428+00:00","market_key":"0x51c22e7b8ccf1f71d3de328e73b0c4fdc7b7b1ebead622e46774a5097fa25064","fully_correlated":true,"source_merge_lines":1,"source_response_id":11017,"chain_probe_version":"ctf_receipt_condition_amount_erc1155_v1","source_redeem_lines":2,"onchain_merge_unique":1,"transaction_receipts":2,"directly_paid_gas_txs":0,"source_positive_redeem_lines":1,"involved_wallet_erc1155_events":11,"onchain_positive_payout_unique":1,"onchain_redeem_transfer_unique":2,"observed_splits_in_settlement_txs":0,"other_wallet_same_market_payout_logs":19},{"audit_at":"2026-11-18T15:12:24.572428+00:00","market_key":"0x532d2ab2dc8e1c646dc8641ed15f6b7a0b3a0a0ee51fbbe435eec1eb16cffaf3","fully_correlated":true,"source_merge_lines":1,"source_response_id":11016,"chain_probe_version":"ctf_receipt_condition_amount_erc1155_v1","source_redeem_lines":2,"onchain_merge_unique":1,"transaction_receipts":2,"directly_paid_gas_txs":0,"source_positive_redeem_lines":1,"involved_wallet_erc1155_events":11,"onchain_positive_payout_unique":1,"onchain_redeem_transfer_unique":2,"observed_splits_in_settlement_txs":0,"other_wallet_same_market_payout_logs":19},{"audit_at":"2026-11-18T15:12:24.572428+00:00","market_key":"0x6c515212fc82b7902a86eb16f4c9d2890a2cdc3e3e3344743a75aa99a353ed16","fully_correlated":true,"source_merge_lines":0,"source_response_id":11019,"chain_probe_version":"ctf_receipt_condition_amount_erc1155_v1","source_redeem_lines":2,"onchain_merge_unique":0,"transaction_receipts":1,"directly_paid_gas_txs":0,"source_positive_redeem_lines":1,"involved_wallet_erc1155_events":1,"onchain_positive_payout_unique":1,"onchain_redeem_transfer_unique":2,"observed_splits_in_settlement_txs":0,"other_wallet_same_market_payout_logs":19},{"audit_at":"2026-11-18T15:12:24.572428+00:00","market_key":"0x79d34242f85d63f5a959ac5ca7cdb9dbec05c81314523c53078875d04a68cc2c","fully_correlated":true,"source_merge_lines":0,"source_response_id":11021,"chain_probe_version":"ctf_receipt_condition_amount_erc1155_v1","source_redeem_lines":2,"onchain_merge_unique":0,"transaction_receipts":1,"directly_paid_gas_txs":0,"source_positive_redeem_lines":1,"involved_wallet_erc1155_events":1,"onchain_positive_payout_unique":1,"onchain_redeem_transfer_unique":2,"observed_splits_in_settlement_txs":0,"other_wallet_same_market_payout_logs":19},{"audit_at":"2026-11-18T15:12:24.572428+00:00","market_key":"0xa0ddb0817ddfd93c5b397878bf0773ebe42ba533da687014857b86bed3aa5be2","fully_correlated":true,"source_merge_lines":1,"source_response_id":11018,"chain_probe_version":"ctf_receipt_condition_amount_erc1155_v1","source_redeem_lines":2,"onchain_merge_unique":1,"transaction_receipts":2,"directly_paid_gas_txs":0,"source_positive_redeem_lines":1,"involved_wallet_erc1155_events":11,"onchain_positive_payout_unique":1,"onchain_redeem_transfer_unique":2,"observed_splits_in_settlement_txs":0,"other_wallet_same_market_payout_logs":19},{"audit_at":"2026-11-18T15:12:24.572428+00:00","market_key":"0xb6965040334879ae7d4bcad80db19a91193e95a305e0c8326fb51a9dd723d3bf","fully_correlated":true,"source_merge_lines":1,"source_response_id":11015,"chain_probe_version":"ctf_receipt_condition_amount_erc1155_v1","source_redeem_lines":2,"onchain_merge_unique":1,"transaction_receipts":2,"directly_paid_gas_txs":0,"source_positive_redeem_lines":1,"involved_wallet_erc1155_events":11,"onchain_positive_payout_unique":1,"onchain_redeem_transfer_unique":2,"observed_splits_in_settlement_txs":0,"other_wallet_same_market_payout_logs":19},{"audit_at":"2026-11-18T15:12:24.572428+00:00","market_key":"0xd12580379938c26865fdd2ef763df7e7736d569e6b4c6efe18b28822d97ac69e","fully_correlated":true,"source_merge_lines":0,"source_response_id":11022,"chain_probe_version":"ctf_receipt_condition_amount_erc1155_v1","source_redeem_lines":2,"onchain_merge_unique":0,"transaction_receipts":1,"directly_paid_gas_txs":0,"source_positive_redeem_lines":1,"involved_wallet_erc1155_events":1,"onchain_positive_payout_unique":1,"onchain_redeem_transfer_unique":2,"observed_splits_in_settlement_txs":0,"other_wallet_same_market_payout_logs":15}]'::jsonb)
on conflict(market_key) do nothing;
-- Expected 8/8 fully correlated; 4/4 MERGE; 16/16 REDEEM transfers;
-- 8/8 positive PayoutRedemption amounts; 148 unrelated payout logs excluded;
-- no RN1 gas payer in the 12 audited transactions.
select count(*) markets,count(*) filter(where fully_correlated) confirmed,
 sum(source_merge_lines) merges,sum(onchain_merge_unique) onchain_merges,
 sum(source_redeem_lines) redeemed_positions,
 sum(onchain_redeem_transfer_unique) onchain_transfer_matches,
 sum(other_wallet_same_market_payout_logs) excluded_unrelated_payouts,
 sum(directly_paid_gas_txs) direct_wallet_gas_txs
from pi.rn1_chain_settlement_audit;
