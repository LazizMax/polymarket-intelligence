-- Sequence-level behavioural fingerprint, evaluated oldest -> newest over a FROZEN
-- public-source archive cohort. This is observed signed TRADE flow, not wallet inventory.
-- Unexecuted orders, prior inventory and interleaved mergers are not identifiable.
create table if not exists pi.rn1_sequence_jobs (
 job_key text primary key check(job_key='rn1_executed_flow'),
 cohort_last_page bigint not null check(cohort_last_page>=1),
 next_page bigint not null check(next_page>=0),
 pages_done bigint not null default 0,
 observed_fills bigint not null default 0,
 valid_fills bigint not null default 0,
 status text not null default 'running'
   check(status in('running','complete','paused_quota','paused_error')),
 lease_until timestamptz,
 last_success_at timestamptz,
 completed_at timestamptz,
 error_attempts integer not null default 0,
 last_error text,
 started_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table if not exists pi.rn1_sequence_market_state (
 market_key text primary key,
 buy0_shares double precision not null default 0,
 buy1_shares double precision not null default 0,
 sell0_shares double precision not null default 0,
 sell1_shares double precision not null default 0,
 fills0 integer not null default 0,
 fills1 integer not null default 0,
 first_at timestamptz not null,
 first_side smallint not null check(first_side in(0,1)),
 first_opposite_at timestamptz,
 last_at timestamptz not null,
 last_at0 timestamptz,
 last_at1 timestamptz,
 last_price0 double precision,
 last_price1 double precision,
 updated_at timestamptz not null default now()
);
create table if not exists pi.rn1_sequence_page_stats (
 page_no bigint primary key,
 source_sha text not null,
 cohort_last_page bigint not null,
 sample_half text not null check(sample_half in('older','newer')),
 analyzed_at timestamptz not null default now(),
 stats jsonb not null check(jsonb_typeof(stats)='object')
);
create index if not exists idx_pi_rn1_sequence_page_cohort on pi.rn1_sequence_page_stats(cohort_last_page,page_no);
alter table pi.rn1_sequence_jobs enable row level security;
alter table pi.rn1_sequence_market_state enable row level security;
alter table pi.rn1_sequence_page_stats enable row level security;
revoke all on pi.rn1_sequence_jobs,pi.rn1_sequence_market_state,pi.rn1_sequence_page_stats from public,anon,authenticated;
grant select,insert,update,delete on pi.rn1_sequence_jobs,pi.rn1_sequence_market_state,pi.rn1_sequence_page_stats to service_role;
-- The first cohort is intentionally frozen. It must not silently absorb pages
-- collected during analysis (newest-first source would change opening state).
insert into pi.rn1_sequence_jobs(job_key,cohort_last_page,next_page)
select 'rn1_executed_flow',max(page_no),max(page_no)
from pi.rn1_full_archive_pages where stream='trades_all'
having max(page_no)>=20
on conflict(job_key) do nothing;
