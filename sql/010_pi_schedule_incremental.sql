-- 5 wallets every 15 min; Vault token never embedded in SQL or GitHub source.
select cron.schedule(
 'pi-pnl-refresh-5-wallets-15min',
 '*/15 * * * *',
 $$
 select net.http_post(
  url:='https://bxfvgywfiifnsbjgudzj.supabase.co/functions/v1/pi-ingest',
  body:='{"action":"scheduled","limit":5}'::jsonb,
  headers:=jsonb_build_object(
   'Content-Type','application/json',
   'x-pi-scheduler-token',(select decrypted_secret from vault.decrypted_secrets
      where name='pi_ingest_scheduler_token')
  ),
  timeout_milliseconds:=60000
 ) as request_id;
 $$
);
