-- Vault-backed scheduler: safe, read-only replay (no keys in the repository).
-- Must be installed after pi-rn1-replay deployment and private schema.
select cron.schedule(
 'pi-rn1-large-replay-1min','* * * * *',
 $task$
 select net.http_post(
  url:='https://bxfvgywfiifnsbjgudzj.supabase.co/functions/v1/pi-rn1-replay',
  body:='{"action":"rn1_replay_tick","pages":4}'::jsonb,
  headers:=jsonb_build_object('Content-Type','application/json',
   'x-pi-scheduler-token',
   (select decrypted_secret from vault.decrypted_secrets where name='pi_ingest_scheduler_token')),
  timeout_milliseconds:=60000
 ) where exists(
  select 1 from pi.rn1_replay_jobs where job_key='rn1_full_chronology_v1'
   and status='running' and (lease_until is null or lease_until<now())
 );
 $task$
);
