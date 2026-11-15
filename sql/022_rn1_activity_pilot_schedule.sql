-- Live RN1 activity pilot: 2 pages x 200 entries, bounded to 4,000 entries total.
-- Does not execute trades and cannot change fees or inventory.
-- Existing private scheduler token in Vault is reused, never exposed to browser.
-- Condition prevents requests after the pilot has finished.
select cron.schedule(
 'pi-rn1-activity-pilot-2min',
 '*/2 * * * *',
 $$
 select net.http_post(
  url:='https://bxfvgywfiifnsbjgudzj.supabase.co/functions/v1/pi-ingest',
  body:='{"action":"rn1_activity_scheduled"}'::jsonb,
  headers:=jsonb_build_object(
    'Content-Type','application/json',
    'x-pi-scheduler-token',(select decrypted_secret from vault.decrypted_secrets where name='pi_ingest_scheduler_token')
  ),
  timeout_milliseconds:=60000
 )
 where exists (select 1 from pi.rn1_activity_import_state where wallet='0x2005d16a84ceefa912d4e380cd32e7ff827875ea' and status='collecting');
 $$
);
-- To stop this independent collector:
-- select cron.unschedule(jobid) from cron.job where jobname='pi-rn1-activity-pilot-2min';
