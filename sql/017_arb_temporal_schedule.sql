-- Bounded low-frequency market-data collection. Uses EXISTING Vault scheduler token.
-- 12 selected liquid binary books every 10 minutes, 50 shares per side, 14-day DB retention.
-- No funds, order credentials, or real trading. Disable without touching the main ROI/PnL jobs:
-- select cron.unschedule(jobid) from cron.job where jobname='pi-arb-temporal-books-10min';
select cron.schedule(
 'pi-arb-temporal-books-10min',
 '*/10 * * * *',
 $$
 select net.http_post(
  url:='https://bxfvgywfiifnsbjgudzj.supabase.co/functions/v1/pi-ingest',
  body:='{"action":"arb_temporal_scheduled"}'::jsonb,
  headers:=jsonb_build_object(
   'Content-Type','application/json',
   'x-pi-scheduler-token',(select decrypted_secret from vault.decrypted_secrets where name='pi_ingest_scheduler_token')
  ),
  timeout_milliseconds:=60000
 );
 $$
);
