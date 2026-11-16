-- RN1 bounded study of original Polymarket V2 EIP-712 signed orders,
-- cryptographically recomputed from matchOrders calldata (Polygon).
-- Creation time is *declared in the signature*, not proven CLOB posting time.
create table if not exists pi.rn1_maker_calldata_sample_txs (
 transaction_hash text primary key,
 cohort text not null check(cohort in ('random_tx','persistent_order','multi_level')),
 priority integer not null default 1,
 status text not null default 'pending' check(status in ('pending','confirmed','unsupported','error')),
 matched_orders integer not null default 0,
 error_attempts integer not null default 0,
 error_message text,last_attempt_at timestamptz,verified_at timestamptz,
 lease_until timestamptz
);
create table if not exists pi.rn1_maker_calldata_signed_orders(
 order_hash text primary key,source_transaction_hash text not null,
 declared_created_ms bigint not null,token_id text not null,
 signed_buy_amount numeric not null,signed_receive_shares numeric not null,
 signed_price numeric not null,salt numeric not null,signer text not null,
 signature_type smallint not null,builder text not null,metadata text not null,
 sampled_cohort text not null,cryptographic_match boolean not null check(cryptographic_match),
 decoded_at timestamptz not null default now()
);
alter table pi.rn1_maker_calldata_sample_txs enable row level security;
alter table pi.rn1_maker_calldata_signed_orders enable row level security;
revoke all on pi.rn1_maker_calldata_sample_txs,pi.rn1_maker_calldata_signed_orders from anon,authenticated;
create index if not exists rn1_maker_calldata_creation_idx
 on pi.rn1_maker_calldata_signed_orders(declared_created_ms);
create or replace view pi.rn1_maker_calldata_execution_analysis with (security_invoker=true) as
select c.order_hash,c.sampled_cohort,c.source_transaction_hash,c.declared_created_ms,
 to_timestamp(c.declared_created_ms/1000.0) declared_created_at,
 c.signed_buy_amount/1000000 signed_notional_usdc,
 c.signed_receive_shares/1000000 signed_order_shares,
 c.signed_price,c.signature_type,
 o.event_slug,o.market_key,o.first_fill_at,o.last_fill_at,
 o.verified_fills,o.transaction_count,o.observed_fill_span_seconds,
 o.filled_shares,o.gross_notional,
 extract(epoch from o.first_fill_at-to_timestamp(c.declared_created_ms/1000.0)) age_to_first_fill_seconds,
 o.filled_shares/nullif(c.signed_receive_shares/1000000,0) observed_fill_ratio
from pi.rn1_maker_calldata_signed_orders c join pi.rn1_maker_signed_orders o
 on o.order_hash=c.order_hash;
revoke all on pi.rn1_maker_calldata_execution_analysis from anon,authenticated;

-- Three explicitly separate groups. The 900-row candidate list of random
-- transaction hashes overlaps with the two targeted groups, hence fewer than
-- 900 additional random rows. The selection is deterministic and finite.
with persistent as (
 select distinct on (o.order_hash) f.transaction_hash
 from pi.rn1_maker_signed_orders o
 join pi.rn1_maker_historical_fills f on f.maker_order_hash=o.order_hash
 where o.transaction_count>=2 and o.observed_fill_span_seconds>=60
 order by o.order_hash,f.trade_at,f.transaction_hash
)
insert into pi.rn1_maker_calldata_sample_txs(transaction_hash,cohort,priority)
select transaction_hash,'persistent_order',1 from persistent
order by md5(transaction_hash) limit 150 on conflict do nothing;
with levels as (
 select transaction_hash from pi.rn1_maker_historical_fills
 where maker_order_hash is not null
 group by transaction_hash having count(distinct round(price,3))>=2
)
insert into pi.rn1_maker_calldata_sample_txs(transaction_hash,cohort,priority)
select transaction_hash,'multi_level',1 from levels
order by md5(transaction_hash) limit 150 on conflict do nothing;
insert into pi.rn1_maker_calldata_sample_txs(transaction_hash,cohort,priority)
select transaction_hash,'random_tx',1 from pi.rn1_maker_historical_transaction_lots
where role='maker' order by md5(transaction_hash) limit 900 on conflict do nothing;
-- The runner independently reshuffles by md5(hash||':calldata-randomized-order-v1')
-- to avoid front-loading the random cohort whose initial selection used md5.
-- Cron runs only while pending work exists, with DB budget and retry limits.
