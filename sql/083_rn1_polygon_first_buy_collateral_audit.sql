-- Follow-up to 081 and 082. Eight sample BUY transactions, exactly ONE
-- prespecified trade per independently sampled, balanced RN1 market.
-- SOURCE trade quantity * price has been matched to the pUSD ERC20 Transfer
-- directly from RN1 to the Polymarket exchange, and an ERC1155 Transfer of
-- the same token quantity directly to RN1 within the same Polygon receipt.
-- This is a sample, NOT full market cost and not an estimate of commissions.
create table if not exists pi.rn1_chain_acquisition_sample(
 market_key text primary key references pi.rn1_ledger_holdout_audit(market_key),
 source_tx_hash text not null,
 source_trade_shares numeric not null,
 source_trade_limit_price numeric not null,
 archived_buy_collateral numeric not null,
 observed_direct_pusd_debit numeric,
 observed_received_shares numeric,
 exact_collateral_debit boolean not null,
 exact_share_receipt boolean not null,
 direct_wallet_gas_payer boolean not null,
 source_response_id bigint not null,
 verified_at timestamptz not null default now()
);
alter table pi.rn1_chain_acquisition_sample enable row level security;
revoke all on pi.rn1_chain_acquisition_sample from anon,authenticated;
insert into pi.rn1_chain_acquisition_sample
select * from jsonb_populate_recordset(null::pi.rn1_chain_acquisition_sample,
 '[{"market_key":"0x2cbd9e101c127565af3504f2122d3ba27e8b17f47f54906541ed18179c79fae1","verified_at":"2026-11-18T15:22:08.717138+00:00","source_tx_hash":"0xc9d3473efc2c0f330ac80ca47ac9e2a2029b87c51d0b4bd148d736886987d3cc","source_response_id":11043,"exact_share_receipt":true,"source_trade_shares":662.642858,"exact_collateral_debit":true,"archived_buy_collateral":477.1028580250572,"direct_wallet_gas_payer":false,"observed_received_shares":662.642858,"source_trade_limit_price":0.7200000004,"observed_direct_pusd_debit":477.102858},{"market_key":"0x51c22e7b8ccf1f71d3de328e73b0c4fdc7b7b1ebead622e46774a5097fa25064","verified_at":"2026-11-18T15:22:08.717138+00:00","source_tx_hash":"0x0b0f762efcbe707d4d271aa901f11ff4e2577070a46e42697d4c79fca3287731","source_response_id":11040,"exact_share_receipt":true,"source_trade_shares":2004,"exact_collateral_debit":true,"archived_buy_collateral":1162.32,"direct_wallet_gas_payer":false,"observed_received_shares":2004,"source_trade_limit_price":0.58,"observed_direct_pusd_debit":1162.32},{"market_key":"0x532d2ab2dc8e1c646dc8641ed15f6b7a0b3a0a0ee51fbbe435eec1eb16cffaf3","verified_at":"2026-11-18T15:22:08.717138+00:00","source_tx_hash":"0xff4f74360d27c6dc2f0c08561013d9c0628dcd4cf417f7d88fe2d68d5f069e91","source_response_id":11039,"exact_share_receipt":true,"source_trade_shares":2.8169,"exact_collateral_debit":true,"archived_buy_collateral":0.8169009999999999,"direct_wallet_gas_payer":false,"observed_received_shares":2.8169,"source_trade_limit_price":0.29,"observed_direct_pusd_debit":0.816901},{"market_key":"0x6c515212fc82b7902a86eb16f4c9d2890a2cdc3e3e3344743a75aa99a353ed16","verified_at":"2026-11-18T15:22:08.717138+00:00","source_tx_hash":"0x3ea333eedd982d14abf7bfbdd1a67c9dd3e4562113347eb7d72640ef43f79c6c","source_response_id":11042,"exact_share_receipt":true,"source_trade_shares":10,"exact_collateral_debit":true,"archived_buy_collateral":4.4,"direct_wallet_gas_payer":false,"observed_received_shares":10,"source_trade_limit_price":0.44,"observed_direct_pusd_debit":4.4},{"market_key":"0x79d34242f85d63f5a959ac5ca7cdb9dbec05c81314523c53078875d04a68cc2c","verified_at":"2026-11-18T15:22:08.717138+00:00","source_tx_hash":"0x88957b7d9d1f15fcecc2de63d84ecedd95ca3f0a758419898f3f16a32b4119d5","source_response_id":11044,"exact_share_receipt":true,"source_trade_shares":2549.542453,"exact_collateral_debit":true,"archived_buy_collateral":1198.28495291,"direct_wallet_gas_payer":false,"observed_received_shares":2549.542453,"source_trade_limit_price":0.47,"observed_direct_pusd_debit":1198.284953},{"market_key":"0xa0ddb0817ddfd93c5b397878bf0773ebe42ba533da687014857b86bed3aa5be2","verified_at":"2026-11-18T15:22:08.717138+00:00","source_tx_hash":"0x5780d5d27152b576f249d3bcee99e085e8136ad4f1c32f2f39eccec79da70f4b","source_response_id":11041,"exact_share_receipt":true,"source_trade_shares":1099.5,"exact_collateral_debit":true,"archived_buy_collateral":626.7149999999999,"direct_wallet_gas_payer":false,"observed_received_shares":1099.5,"source_trade_limit_price":0.57,"observed_direct_pusd_debit":626.715},{"market_key":"0xb6965040334879ae7d4bcad80db19a91193e95a305e0c8326fb51a9dd723d3bf","verified_at":"2026-11-18T15:22:08.717138+00:00","source_tx_hash":"0x81fe5dc6347899cf28e35242f8f5d201dd936bc09dd72d292d9bbfb8c73c98ee","source_response_id":11038,"exact_share_receipt":true,"source_trade_shares":10.227273,"exact_collateral_debit":true,"archived_buy_collateral":5.727272999659094,"direct_wallet_gas_payer":false,"observed_received_shares":10.227273,"source_trade_limit_price":0.5600000117,"observed_direct_pusd_debit":5.727273},{"market_key":"0xd12580379938c26865fdd2ef763df7e7736d569e6b4c6efe18b28822d97ac69e","verified_at":"2026-11-18T15:22:08.717138+00:00","source_tx_hash":"0x44a154fd376d884f1c8e8f0aa86bb6ec2cb22a92bfbd4972e714c98d0ff6b05f","source_response_id":11045,"exact_share_receipt":true,"source_trade_shares":2500,"exact_collateral_debit":true,"archived_buy_collateral":1600,"direct_wallet_gas_payer":false,"observed_received_shares":2500,"source_trade_limit_price":0.64,"observed_direct_pusd_debit":1600}]'::jsonb)
on conflict(market_key) do nothing;
select count(*) trades,
 count(*) filter(where exact_collateral_debit) wallet_pusd_debits,
 count(*) filter(where exact_share_receipt) wallet_share_credits,
 round(sum(observed_direct_pusd_debit),6) sample_pusd_spend
from pi.rn1_chain_acquisition_sample;
-- Expected 8/8, 8/8 and 5,075.366985 pUSD. This is only 8 out of
-- 167 total archived BUY fills in the 16-market independent cohort.
