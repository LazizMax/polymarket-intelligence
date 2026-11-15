-- Replace user-click-only ROI backfill with automatic per-wallet scheduling.
-- Controlled: 2 API pages per tick at most (400 closed positions), one wallet
-- per invocation. Keep refreshes away from high CPU bursts on Fit Tracker.
select cron.unschedule(jobid) from cron.job
 where jobname in ('pi-closed-roi-backfill-5min','pi-closed-roi-auto-2min');

select cron.schedule(
 'pi-closed-roi-auto-2min',
 '*/2 * * * *',
 $$
 select net.http_post(
  url:='https://bxfvgywfiifnsbjgudzj.supabase.co/functions/v1/pi-ingest',
  body:='{"action":"roi_scheduled"}'::jsonb,
  headers:=jsonb_build_object(
   'Content-Type','application/json',
   'x-pi-scheduler-token',(select decrypted_secret from vault.decrypted_secrets where name='pi_ingest_scheduler_token')
  ),
  timeout_milliseconds:=60000
 );
 $$
);
