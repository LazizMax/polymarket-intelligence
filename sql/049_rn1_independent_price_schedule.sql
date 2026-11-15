-- Schedule only while replay reports running; secrets remain encrypted in Vault.
select cron.schedule('pi-rn1-independent-prices-1min','* * * * *',
$task$
 select net.http_post(
  url:='https://bxfvgywfiifnsbjgudzj.supabase.co/functions/v1/pi-rn1-independent-price',
  body:='{"action":"independent_price_tick","pages":3}'::jsonb,
  headers:=jsonb_build_object(
   'Content-Type','application/json',
   'x-pi-scheduler-token',(select decrypted_secret from vault.decrypted_secrets where name='pi_ingest_scheduler_token')
  ),
  timeout_milliseconds:=60000
 )
 where exists(select 1 from pi.rn1_independent_price_jobs
  where job_key='rn1_independent_price_v1' and status='running'
   and (lease_until is null or lease_until<now()));
$task$
);
