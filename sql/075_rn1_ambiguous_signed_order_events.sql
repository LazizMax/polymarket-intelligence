-- Ambiguous wallet Maker order event mapping:
-- a blockchain OrderFilled event can be confirmed even when source fills have
-- identical market, token, price, quantity and second. Never fabricate the
-- fingerprint-to-order mapping in that case.
create table if not exists pi.rn1_maker_ambiguous_order_events (
 transaction_hash text not null,
 log_index integer not null,
 order_hash text not null,
 token_id text not null,
 execution_price numeric not null,
 filled_shares numeric not null,
 audit_status text not null default 'confirmed_onchain_unmapped'
   check (audit_status='confirmed_onchain_unmapped'),
 inspected_at timestamptz not null default now(),
 primary key (transaction_hash,log_index),
 unique (transaction_hash,order_hash,log_index)
);
alter table pi.rn1_maker_ambiguous_order_events enable row level security;
revoke all on pi.rn1_maker_ambiguous_order_events from anon,authenticated;
create index if not exists rn1_maker_ambiguous_orderhash_idx
 on pi.rn1_maker_ambiguous_order_events(order_hash);
