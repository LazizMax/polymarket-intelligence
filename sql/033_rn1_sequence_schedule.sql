-- Frozen-cohort RN1 trade-flow analysis: 5 source pages per tick.
-- No orders, no secret in browser, no overlap with existing source collector.
-- Automatically becomes inert when the cohort is complete or paused.
select cron.schedule(
 'pi-rn1-sequence-fingerprint-1min',
 '* * * * *',
 $$
 select net.http_post(
  url:='https://bxfvgywfiifnsbjgudzj.supabase.co/functions/v1/pi-ingest',
  body:='{"action":"rn1_sequence_scheduled"}'::jsonb,
  headers:=jsonb_build_object(
   'Content-Type','application/json',
   'x-pi-scheduler-token',(select decrypted_secret from vault.decrypted_secrets where name='pi_ingest_scheduler_token')),
  timeout_milliseconds:=60000
 )
 where exists(select 1 from pi.rn1_sequence_jobs
  where job_key='rn1_executed_flow' and status='running'
  and (lease_until is null or lease_until<now()));
 $$
);
