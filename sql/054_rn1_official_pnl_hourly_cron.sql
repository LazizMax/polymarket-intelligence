select cron.schedule(
 'pi-rn1-official-pnl-hourly','7 * * * *',
 $job$
 select net.http_post(
  url:='https://qamdvfakwclkuswrdckp.supabase.co/functions/v1/pi-rn1-official-pnl',
  body:='{"action":"refresh_official_rn1_pnl"}'::jsonb,
  headers:=jsonb_build_object('Content-Type','application/json',
   'x-pi-scheduler-token',
   (select decrypted_secret from vault.decrypted_secrets where name='pi_ingest_scheduler_token')),
  timeout_milliseconds:=60000)
 $job$
);