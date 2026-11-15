-- Bounded RN1 V2 trade evidence pilot.
-- 2 pages x 200 rows per job, automatically stops at 4,000 observed rows.
-- Uses the EXISTING Vault-backed scheduler credential. No order execution.
select cron.schedule(
 'pi-rn1-trades-pilot-2min',
 '*/2 * * * *',
 $$
 select net.http_post(
  url:='https://bxfvgywfiifnsbjgudzj.supabase.co/functions/v1/pi-ingest',
  body:='{"action":"rn1_trades_scheduled"}'::jsonb,
  headers:=jsonb_build_object(
   'Content-Type','application/json',
   'x-pi-scheduler-token',
   (select decrypted_secret from vault.decrypted_secrets where name='pi_ingest_scheduler_token')
  ),
  timeout_milliseconds:=60000
 );
 $$
);
-- If necessary disable independently:
-- select cron.unschedule(jobid) from cron.job where jobname='pi-rn1-trades-pilot-2min';
