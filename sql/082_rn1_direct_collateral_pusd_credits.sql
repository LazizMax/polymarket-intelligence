-- Follow-up to sql/081. Direct pUSD ERC20 transfers (0xc011a7...)
-- minted to the RN1 wallet, uniquely matching archive MERGE and positive
-- REDEEM collateral proceeds in exactly the same signed transactions.
-- Batching frequently covers other markets or participants; match amount and
-- transaction individually, not the transaction's full collateral throughput.
alter table pi.rn1_chain_settlement_audit
 add column if not exists direct_pusd_merge_credit_count integer,
 add column if not exists direct_pusd_redeem_credit_count integer,
 add column if not exists direct_pusd_merge_credit numeric,
 add column if not exists direct_pusd_redeem_credit numeric,
 add column if not exists direct_pusd_all_credits_matched boolean,
 add column if not exists collateral_receipt_response_id bigint;

with evidence as(
select * from jsonb_to_recordset('[{"verified":true,"market_key":"0x2cbd9e101c127565af3504f2122d3ba27e8b17f47f54906541ed18179c79fae1","merge_count":0,"response_id":11031,"merge_credit":0,"redeem_count":1,"redeem_credit":3691.002858},{"verified":true,"market_key":"0x51c22e7b8ccf1f71d3de328e73b0c4fdc7b7b1ebead622e46774a5097fa25064","merge_count":1,"response_id":11028,"merge_credit":12346.5,"redeem_count":1,"redeem_credit":1648.67627},{"verified":true,"market_key":"0x532d2ab2dc8e1c646dc8641ed15f6b7a0b3a0a0ee51fbbe435eec1eb16cffaf3","merge_count":1,"response_id":11027,"merge_credit":1418.1007,"redeem_count":1,"redeem_credit":61.354498},{"verified":true,"market_key":"0x6c515212fc82b7902a86eb16f4c9d2890a2cdc3e3e3344743a75aa99a353ed16","merge_count":0,"response_id":11030,"merge_credit":0,"redeem_count":1,"redeem_credit":274.19101},{"verified":true,"market_key":"0x79d34242f85d63f5a959ac5ca7cdb9dbec05c81314523c53078875d04a68cc2c","merge_count":0,"response_id":11032,"merge_credit":0,"redeem_count":1,"redeem_credit":122.309524},{"verified":true,"market_key":"0xa0ddb0817ddfd93c5b397878bf0773ebe42ba533da687014857b86bed3aa5be2","merge_count":1,"response_id":11029,"merge_credit":5551.2265,"redeem_count":1,"redeem_credit":4899.011148},{"verified":true,"market_key":"0xb6965040334879ae7d4bcad80db19a91193e95a305e0c8326fb51a9dd723d3bf","merge_count":1,"response_id":11026,"merge_credit":4016.2272,"redeem_count":1,"redeem_credit":3303.112423},{"verified":true,"market_key":"0xd12580379938c26865fdd2ef763df7e7736d569e6b4c6efe18b28822d97ac69e","merge_count":0,"response_id":11033,"merge_credit":0,"redeem_count":1,"redeem_credit":50}]'::jsonb)
as a(market_key text,merge_count integer,redeem_count integer,
 merge_credit numeric,redeem_credit numeric,verified boolean,response_id bigint)
)
update pi.rn1_chain_settlement_audit a set
 direct_pusd_merge_credit_count=e.merge_count,
 direct_pusd_redeem_credit_count=e.redeem_count,
 direct_pusd_merge_credit=e.merge_credit,
 direct_pusd_redeem_credit=e.redeem_credit,
 direct_pusd_all_credits_matched=e.verified,
 collateral_receipt_response_id=e.response_id
from evidence e where a.market_key=e.market_key;

-- Expected: 8/8 markets, 4 MERGE, 8 positive REDEEM receipts,
-- 37,381.712131 pUSD credited to the wallet. Not after-fees PnL.
select count(*) markets,count(*) filter(where direct_pusd_all_credits_matched) verified,
 sum(direct_pusd_merge_credit_count) credited_merge_events,
 sum(direct_pusd_redeem_credit_count) credited_redeem_events,
 round(sum(direct_pusd_merge_credit+direct_pusd_redeem_credit),6) p_usd_credited
from pi.rn1_chain_settlement_audit;
