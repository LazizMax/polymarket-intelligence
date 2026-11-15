-- Reproducible one-time research sample: STRICTLY historical reference prices and official payout.
-- This is never a real execution book, realized profit, or trader's historical full inventory.
create table if not exists pi.rn1_fill_price_benchmark(
 wallet text not null references pi.wallets(wallet),
 trade_key text not null,
 market_key text not null,
 token_id text not null references pi.rn1_price_history_evidence(token_id),
 bought_at timestamptz not null,
 shares numeric not null check(shares>0),
 fill_price numeric not null check(fill_price between 0 and 1),
 payout_per_share numeric not null check(payout_per_share between 0 and 1),
 resolved_at timestamptz not null,
 reference_price numeric check(reference_price between 0 and 1),
 reference_epoch bigint,
 reference_width_seconds integer,
 prior_5m_price numeric check(prior_5m_price between 0 and 1),
 after_15m_price numeric check(after_15m_price between 0 and 1),
 after_15m_epoch bigint,
 computed_at timestamptz not null default now(),
 primary key(wallet,trade_key),
 constraint pi_rn1_reference_before_trade check (
  reference_epoch is null or
  reference_epoch+coalesce(reference_width_seconds,0)<=extract(epoch from bought_at)
 ),
 constraint pi_rn1_reference_not_stale check (
  reference_epoch is null or
  extract(epoch from bought_at)-(reference_epoch+coalesce(reference_width_seconds,0))<=120
 ),
 constraint pi_rn1_post15_after_trade check (
  after_15m_epoch is null or after_15m_epoch>=extract(epoch from bought_at)+900
 )
);
create index if not exists idx_pi_rn1_benchmark_market on pi.rn1_fill_price_benchmark(market_key,bought_at);
alter table pi.rn1_fill_price_benchmark enable row level security;
revoke all on pi.rn1_fill_price_benchmark from public,anon,authenticated;
grant select,insert,update,delete on pi.rn1_fill_price_benchmark to service_role;
