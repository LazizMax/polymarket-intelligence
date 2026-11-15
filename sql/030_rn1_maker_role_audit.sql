-- Maker/taker role audit by comparing Polymarket v2 taker_only=true and false
-- for the same wallet and bounded UTC interval. Each raw full-source page is preserved.
alter table pi.rn1_full_archive_pages
 add column if not exists role_status text not null default 'pending',
 add column if not exists maker_fills integer,
 add column if not exists taker_fills integer,
 add column if not exists role_checked_at timestamptz,
 add column if not exists role_lease_until timestamptz,
 add column if not exists role_attempts integer not null default 0,
 add column if not exists role_error text;
alter table pi.rn1_full_archive_pages
 add constraint rn1_full_archive_role_status_check
 check (role_status in('pending','verified','partial','error','not_applicable'));
alter table pi.rn1_full_archive_pages
 add constraint rn1_full_archive_role_counts_check
 check(role_status<>'verified' or (
 maker_fills is not null and taker_fills is not null
 and maker_fills>=0 and taker_fills>=0 and maker_fills+taker_fills=valid_count));
update pi.rn1_full_archive_pages set role_status='not_applicable'
 where stream='activity_all';
create index if not exists idx_pi_rn1_full_role_audit_queue
 on pi.rn1_full_archive_pages(page_no)
 where stream='trades_all' and role_status in('pending','error');
