-- Snapshot migration: pi.rn1_chain_acquisition_queue
-- Exactly eight independently selected balanced markets. One row per market+transaction.
-- Entries seeded from original timeline, not from RPC estimates.
-- All future RPC validations must respect source market, tx, outcome and spend aggregation.
create table if not exists pi.rn1_chain_acquisition_queue (
 market_key text not null references pi.rn1_ledger_holdout_audit(market_key),
 source_tx_hash text not null,
 source_fill_count integer not null,
 archived_shares numeric not null,
 archived_cost numeric not null,
 source_outcomes integer[] not null,
 source_first_at timestamptz,
 source_last_at timestamptz,
 audit_status text not null default 'pending' check (audit_status in ('pending','verified','mismatch','error')),
 observed_pusd_debit numeric,
 observed_shares_received numeric,
 observed_wallet_pusd_in numeric,
 observed_wallet_pusd_out numeric,
 observed_gas_payer text,
 audit_note text,
 last_checked_at timestamptz,
 primary key (market_key,source_tx_hash)
);
alter table pi.rn1_chain_acquisition_queue enable row level security;
revoke all on pi.rn1_chain_acquisition_queue from anon, authenticated;

insert into pi.rn1_chain_acquisition_queue
(market_key,source_tx_hash,source_fill_count,archived_shares,archived_cost,source_outcomes,source_first_at,source_last_at)
select l.market_key,lower(e.event->>'tx'),count(*)::integer,
       sum((e.event->>'shares')::numeric),
       sum(-(e.event->>'cash_delta')::numeric),
       array_agg(distinct (e.event->>'outcome')::integer order by (e.event->>'outcome')::integer),
       to_timestamp(min((e.event->>'t')::numeric)),
       to_timestamp(max((e.event->>'t')::numeric))
from pi.rn1_ledger_holdout_audit l
join pi.rn1_chain_settlement_audit s using(market_key)
cross join lateral jsonb_array_elements(l.timeline) e(event)
where e.event->>'kind'='TRADE' and e.event->>'side'='BUY'
  and lower(e.event->>'tx') ~ '^0x[0-9a-f]{64}$'
group by l.market_key,lower(e.event->>'tx')
on conflict(market_key,source_tx_hash) do nothing;

update pi.rn1_chain_acquisition_queue q
set audit_status='verified',
    observed_pusd_debit=s.observed_direct_pusd_debit,
    observed_shares_received=s.observed_received_shares,
    observed_wallet_pusd_out=s.observed_direct_pusd_debit,
    observed_gas_payer=case when s.direct_wallet_gas_payer then 'RN1' else 'OTHER' end,
    audit_note='Previously verified first BUY in chain acquisition sample; original receipt evidence',
    last_checked_at=s.verified_at
from pi.rn1_chain_acquisition_sample s
where q.market_key=s.market_key and q.source_tx_hash=lower(s.source_tx_hash)
  and s.exact_collateral_debit and s.exact_share_receipt
  and q.source_fill_count=1
  and abs(q.archived_cost-s.archived_buy_collateral)<0.000002
  and abs(q.archived_shares-s.source_trade_shares)<0.000002;
