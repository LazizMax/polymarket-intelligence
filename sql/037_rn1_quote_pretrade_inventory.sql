-- Public RN1 position holdings observed PRIOR to the public CLOB books and later fills.
-- The API serves only current OPEN positions; absence on a successfully completed
-- condition-filtered response means zero current open holding, not historical zero.
alter table pi.rn1_quote_probe_runs
 add column if not exists position_observed_at timestamptz,
 add column if not exists position_status text not null default 'unavailable'
   check(position_status in('complete','unavailable')),
 add column if not exists positions jsonb not null default '[]'::jsonb
   check(jsonb_typeof(positions)='array');

comment on column pi.rn1_quote_probe_runs.positions is
 'OPEN public RN1 positions by token on the sampled 8 conditions, observed before /books and only used for subsequent fills. Zero on omitted token only when position_status=complete.';
comment on column pi.rn1_quote_probe_runs.position_observed_at is
 'End of filtered Data API positions HTTP response; must precede CLOB book receipt and any matched future fill.';
