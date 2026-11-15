select cron.schedule(
 'pi-rn1-pattern-fills-10s','10 seconds',
 $job$
 select net.http_post(
 url:='https://qamdvfakwclkuswrdckp.supabase.co/functions/v1/pi-rn1-pattern-fills',
 body:='{"action":"profile_rn1_frozen_fills","count":12}'::jsonb,
 headers:=jsonb_build_object('Content-Type','application/json','x-pi-scheduler-token',
  (select decrypted_secret from vault.decrypted_secrets where name='pi_ingest_scheduler_token')),
 timeout_milliseconds:=60000)
 where exists(select 1 from pi.rn1_pattern_jobs
 where job_key='rn1_fill_setup_756k_v1' and status='running'
 and (lease_until is null or lease_until<now()));
 $job$
);