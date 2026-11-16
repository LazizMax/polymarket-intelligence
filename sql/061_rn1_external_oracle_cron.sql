-- One invocation per UTC hour. The worker makes ZERO bookmaker requests until
-- RN1_ODDS_API_KEY is configured manually as an Edge Function secret.
-- The worker additionally enforces 50-minute cooldown, 24/day, 5000-row hard cap.
select cron.schedule(
 'pi-rn1-external-oracle-1hour',
 '0 * * * *',
 $job$
 select net.http_post(
  url:='https://qamdvfakwclkuswrdckp.supabase.co/functions/v1/pi-rn1-odds',
  body:='{"action":"odds_capture"}'::jsonb,
  headers:=jsonb_build_object(
   'Content-Type','application/json',
   'x-pi-scheduler-token',
   (select decrypted_secret from vault.decrypted_secrets where name='pi_ingest_scheduler_token')
  ),
  timeout_milliseconds:=20000
 )
 where exists(select 1 from vault.decrypted_secrets where name='pi_ingest_scheduler_token');
 $job$
);
