-- RN1 provenance layer: original on-chain transaction hashes, not order IDs.
-- The underlying fills and page hashes are verified against immutable private Storage.
alter table pi.rn1_maker_historical_fills add column if not exists transaction_hash text;
create index if not exists rn1_maker_historical_txhash_idx
 on pi.rn1_maker_historical_fills(transaction_hash) where transaction_hash is not null;
create table if not exists pi.rn1_maker_tx_audit_pages(
 page_no bigint primary key,
 source_sha256 text not null,
 hashes_matched integer not null,
 distinct_hashes integer not null,
 verified_at timestamptz not null default now()
);
alter table pi.rn1_maker_tx_audit_pages enable row level security;
revoke all on pi.rn1_maker_tx_audit_pages from anon,authenticated;
create or replace view pi.rn1_maker_historical_transaction_lots with (security_invoker=true) as
 select transaction_hash,role,min(event_slug) event_slug,min(market_key) market_key,
  min(token_id) token_id,min(side) side,min(trade_at) first_at,
  count(*)::integer fill_count,count(distinct price)::integer price_levels,
  min(price) min_price,max(price) max_price,
  sum(shares) shares,sum(shares*price) notional
 from pi.rn1_maker_historical_fills where transaction_hash is not null
 group by transaction_hash,role;
revoke all on pi.rn1_maker_historical_transaction_lots from anon,authenticated;
create or replace view pi.rn1_maker_historical_burst_hash_evidence with (security_invoker=true) as
with ordered as (
 select market_key,token_id,role,side,price,trade_at,fingerprint,transaction_hash,shares,
 lag(trade_at) over(partition by market_key,token_id,role,side,price order by trade_at,fingerprint) previous_at
 from pi.rn1_maker_historical_fills where transaction_hash is not null
), flags as (
 select *,case when previous_at is null or trade_at-previous_at>interval '1 second' then 1 else 0 end starts_new from ordered
), clusters as (
 select *,sum(starts_new) over(partition by market_key,token_id,role,side,price order by trade_at,fingerprint rows unbounded preceding) burst_id from flags
)
select role,market_key,token_id,side,price,burst_id,
 min(trade_at) first_at,max(trade_at) last_at,
 count(*)::integer fill_count,count(distinct transaction_hash)::integer blockchain_transactions,
 sum(shares*price) notional
from clusters group by role,market_key,token_id,side,price,burst_id;
revoke all on pi.rn1_maker_historical_burst_hash_evidence from anon,authenticated;
