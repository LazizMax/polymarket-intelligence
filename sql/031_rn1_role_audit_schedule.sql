-- Reconcile every archived full-trade page against wallet taker-only source
-- for its exact UTC time window. Does not place orders or expose archive contents.
select cron.schedule(
 'pi-rn1-maker-audit-2min',
 '*/2 * * * *',
 $$
 select net.http_post(
  url:='https://bxfvgywfiifnsbjgudzj.supabase.co/functions/v1/pi-ingest',
  body:='{"action":"rn1_maker_audit_scheduled"}'::jsonb,
  headers:=jsonb_build_object(
   'Content-Type','application/json',
   'x-pi-scheduler-token',(select decrypted_secret from vault.decrypted_secrets where name='pi_ingest_scheduler_token')),
  timeout_milliseconds:=60000
 )
 where exists(
  select 1 from pi.rn1_full_archive_pages
  where stream='trades_all'
    and role_status in('pending','error')
    and role_attempts<5
    and (role_lease_until is null or role_lease_until<now())
 );
 $$
);
