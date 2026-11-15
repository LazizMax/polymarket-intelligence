-- Automatic wallet coverage + incremental closed-position ROI refreshes.
-- Full initial feed establishes baseline; recent scans never discard older positions.
alter table pi.roi_import_state
  add column if not exists sync_mode text not null default 'initial'
    check (sync_mode in ('initial','recent','full','idle')),
  add column if not exists scan_started_at timestamptz,
  add column if not exists checkpoint_at timestamptz,
  add column if not exists last_recent_at timestamptz,
  add column if not exists last_full_audit_at timestamptz,
  add column if not exists consecutive_failures integer not null default 0;

alter table pi.closed_position_roi
  add column if not exists last_seen_scan_at timestamptz;

-- Upgrade pre-existing finished full scans without resetting or invalidating them.
update pi.roi_import_state
 set sync_mode='idle',
     last_recent_at=coalesce(last_recent_at,last_complete_at,now()),
     last_full_audit_at=coalesce(last_full_audit_at,last_complete_at,now()),
     consecutive_failures=0
 where exhausted=true and last_complete_at is not null;

update pi.roi_import_state set sync_mode='initial'
 where exhausted=false and last_complete_at is null;

-- Adopt every already-tracked wallet; future discovered wallets are inserted by the worker.
insert into pi.roi_import_state(wallet,request_priority)
 select wallet,false from pi.wallets
 on conflict(wallet) do nothing;

create index if not exists idx_pi_roi_sync_mode_due
 on pi.roi_import_state(sync_mode,request_priority,last_attempt_at,last_recent_at,last_full_audit_at);
