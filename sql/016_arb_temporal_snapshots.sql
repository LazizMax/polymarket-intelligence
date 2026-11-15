-- Append-only sampled order book quotes for a bounded, paper-only temporal-arbitrage experiment.
-- Source: Gamma selected CTF binary markets + Polymarket CLOB /books.
-- Do NOT confuse these quotes with actual fills or firm executable prices.
create table if not exists pi.arb_temporal_snapshots (
  snapshot_id bigint generated always as identity primary key,
  batch_id uuid not null,
  observed_at timestamptz not null,
  market_key text not null,
  market_slug text not null,
  question text not null,
  yes_token_id text not null,
  no_token_id text not null,
  quote_shares numeric(16,6) not null check (quote_shares>0 and quote_shares<=1000),
  yes_buy_avg numeric(16,10),
  no_buy_avg numeric(16,10),
  yes_sell_avg numeric(16,10),
  no_sell_avg numeric(16,10),
  yes_best_bid numeric(16,10),
  no_best_bid numeric(16,10),
  yes_best_ask numeric(16,10),
  no_best_ask numeric(16,10),
  source text not null default 'gamma_clob_l2_poll',
  constraint pi_arb_temporal_positive_quote check (
    (yes_buy_avg is null or yes_buy_avg between 0 and 1)
    and (no_buy_avg is null or no_buy_avg between 0 and 1)
    and (yes_sell_avg is null or yes_sell_avg between 0 and 1)
    and (no_sell_avg is null or no_sell_avg between 0 and 1)
  ),
  unique (batch_id,market_key)
);
create index if not exists idx_pi_arb_temporal_market_time
 on pi.arb_temporal_snapshots(market_key,observed_at desc);
create index if not exists idx_pi_arb_temporal_time
 on pi.arb_temporal_snapshots(observed_at desc);

alter table pi.arb_temporal_snapshots enable row level security;
revoke all on pi.arb_temporal_snapshots from public,anon,authenticated;
grant select,insert,update,delete on pi.arb_temporal_snapshots to service_role;
grant usage,select on sequence pi.arb_temporal_snapshots_snapshot_id_seq to service_role;
-- pi is private and not exposed by the Data API; API uses existing authenticated Edge Function.
