-- RN1 Polygon acquisition worker metadata. Applied to project Polymarket Intelligence 2026-11-18.
-- Extensions to initial eight-market transaction queue (see 085).
alter table pi.rn1_chain_acquisition_queue
 add column if not exists audit_attempts integer not null default 0,
 add column if not exists audit_lease_until timestamptz,
 add column if not exists audit_evidence jsonb,
 add column if not exists observed_fee_log_count integer;
alter table pi.rn1_chain_acquisition_queue
 drop constraint if exists rn1_chain_acquisition_queue_audit_status_check;
alter table pi.rn1_chain_acquisition_queue
 add constraint rn1_chain_acquisition_queue_audit_status_check
 check (audit_status in ('pending','verified','ambiguous','mismatch','error'));
create index if not exists rn1_chain_acquisition_pending_idx
 on pi.rn1_chain_acquisition_queue(audit_status,audit_lease_until,source_first_at);
create table if not exists pi.rn1_chain_token_map(
 market_key text primary key references pi.rn1_ledger_holdout_audit(market_key),
 position_token0 text not null,
 position_token1 text not null,
 mapping_method text not null default 'Polygon CTF getCollectionId/getPositionId',
 updated_at timestamptz not null default now()
);
alter table pi.rn1_chain_token_map enable row level security;
revoke all on pi.rn1_chain_token_map from anon, authenticated;
-- Repair evidence from v1 that was escaped as a JSON string.
update pi.rn1_chain_acquisition_queue
set audit_evidence=(audit_evidence #>> '{}')::jsonb
where jsonb_typeof(audit_evidence)='string';
