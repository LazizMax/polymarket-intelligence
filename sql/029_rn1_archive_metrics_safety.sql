-- Full-history archive must keep progressing even if the small shared SQL database
-- can no longer retain detailed per-market rollups. Archived pages remain complete.
alter table pi.rn1_full_streams
 add column if not exists metrics_rows bigint not null default 0,
 add column if not exists metrics_paused_at timestamptz;
