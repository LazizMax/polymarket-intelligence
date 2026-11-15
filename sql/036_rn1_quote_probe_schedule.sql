-- Read-only public CLOB books once a minute, with existing private Vault scheduler.
-- Edge Function itself enforces shared 290 MiB Postgres and 700 MiB gzip budgets.
select cron.schedule(
 'pi-rn1-live-quote-probe-1min',
 '* * * * *',
 $$
 select net.http_post(
  url:='https://bxfvgywfiifnsbjgudzj.supabase.co/functions/v1/pi-rn1-quote-probe',
  body:='{"action":"quote_probe_scheduled"}'::jsonb,
  headers:=jsonb_build_object(
   'Content-Type','application/json',
   'x-pi-scheduler-token',(select decrypted_secret from vault.decrypted_secrets
    where name='pi_ingest_scheduler_token')
  ),
  timeout_milliseconds:=60000
 )
 where exists(select 1 from pi.rn1_quote_probe_state
  where singleton=true and status='collecting'
   and (lease_until is null or lease_until<now()));
 $$
);
