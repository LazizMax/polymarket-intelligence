-- Low-impact backfill for user-requested wallets; 200 closed positions per pass.
-- Uses the preexisting private Vault token. No plaintext secret in source.
select cron.schedule(
 'pi-closed-roi-backfill-5min',
 '*/5 * * * *',
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
 $$);
