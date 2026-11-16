-- RN1 confirmed Maker signed order hashes from public Polygon V2 OrderFilled logs.
-- Sources: https://github.com/Polymarket/ctf-exchange-v2/blob/main/src/exchange/interfaces/ITrading.sol
--         https://github.com/Polymarket/ctf-exchange-v2/blob/main/src/exchange/mixins/Events.sol
-- No private user order API, signer keys or paid data subscription.
alter table pi.rn1_maker_historical_fills
 add column if not exists maker_order_hash text,
 add column if not exists maker_order_log_index integer;
create unique index if not exists rn1_maker_order_log_unique
 on pi.rn1_maker_historical_fills(transaction_hash,maker_order_log_index)
 where maker_order_hash is not null;
create index if not exists rn1_maker_order_hash_idx
 on pi.rn1_maker_historical_fills(maker_order_hash)
 where maker_order_hash is not null;
create table if not exists pi.rn1_maker_onchain_tx_audit(
 transaction_hash text primary key,
 source_fills integer not null,maker_logs integer not null,matched_fills integer not null,
 status text not null check(status in ('confirmed','unmatched','ambiguous')),
 block_number bigint,rpc_provider text,note text,verified_at timestamptz not null default now()
);
alter table pi.rn1_maker_onchain_tx_audit enable row level security;
revoke all on pi.rn1_maker_onchain_tx_audit from anon,authenticated;
create table if not exists pi.rn1_maker_chain_scan_state(
 singleton boolean primary key default true check(singleton),
 status text not null default 'running' check(status in ('running','complete','paused_quota','paused_error')),
 from_block bigint not null,to_block bigint not null,next_block bigint not null,
 chunk_size integer not null default 5000,chunks_done integer not null default 0,
 chain_logs_seen bigint not null default 0,fills_verified bigint not null default 0,
 tx_confirmed bigint not null default 0,tx_unmatched bigint not null default 0,
 lease_until timestamptz,last_success_at timestamptz,last_error text,
 updated_at timestamptz not null default now(),
 error_attempts integer not null default 0
);
alter table pi.rn1_maker_chain_scan_state enable row level security;
revoke all on pi.rn1_maker_chain_scan_state from anon,authenticated;
-- The block bounds were obtained from real receipts of the earliest/latest
-- Maker fills among the existing 80-page archive; avoid extending blindly.
insert into pi.rn1_maker_chain_scan_state
(singleton,status,from_block,to_block,next_block,chunk_size)
values(true,'running',96815414,97339531,96815414,5000)
on conflict(singleton) do nothing;
create or replace view pi.rn1_maker_signed_orders with (security_invoker=true) as
select maker_order_hash order_hash,min(event_slug) event_slug,
 min(market_key) market_key,min(token_id) token_id,
 count(*)::integer verified_fills,
 count(distinct transaction_hash)::integer transaction_count,
 -- Round away raw API floating conversion noise, not evidence of rewrites.
 count(distinct round(price,3))::integer execution_price_count,
 sum(shares) filled_shares,sum(shares*price) gross_notional,
 min(price) min_execution_price,max(price) max_execution_price,
 min(trade_at) first_fill_at,max(trade_at) last_fill_at,
 extract(epoch from max(trade_at)-min(trade_at))::bigint observed_fill_span_seconds
from pi.rn1_maker_historical_fills
where role='maker' and maker_order_hash is not null
group by maker_order_hash;
revoke all on pi.rn1_maker_signed_orders from anon,authenticated;
