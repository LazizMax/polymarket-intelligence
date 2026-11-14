-- A small private allowlist: only the server can read; this does NOT expose Fit Tracker user data.
create table if not exists pi.dashboard_access (
 user_id uuid primary key references auth.users(id) on delete cascade,
 enabled boolean not null default true,
 added_at timestamptz not null default now()
);
alter table pi.dashboard_access enable row level security;
revoke all on pi.dashboard_access from public, anon, authenticated;
grant select on pi.dashboard_access to service_role;
create index if not exists idx_pi_access_enabled on pi.dashboard_access(user_id) where enabled;
