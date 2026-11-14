-- Cron-only access in the private pi schema (no token stored in GitHub).
alter table pi.ingestion_cursors
  add column if not exists last_attempt_at timestamptz,
  add column if not exists last_success_at timestamptz,
  add column if not exists consecutive_failures integer not null default 0,
  add column if not exists last_error text;

create table if not exists pi.scheduler_auth (
  single_row_id integer primary key check (single_row_id=1),
  token_sha256 text not null check (token_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
alter table pi.scheduler_auth enable row level security;
revoke all on pi.scheduler_auth from public,anon,authenticated;
grant select on pi.scheduler_auth to service_role;

create index if not exists idx_pi_ingest_cursor_attempt on pi.ingestion_cursors(last_attempt_at);

