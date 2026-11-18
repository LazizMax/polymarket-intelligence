-- Private, existing Vault token; no secret literal is stored in the job definition.
-- This job only runs while there are pending <=2-attempt acquisition rows.
-- Bounded at two transactions per invocation; worker claims rows with an atomic lease.
select cron.schedule(
 'pi-rn1-acquisition-audit-1min','* * * * *',
 $job$
 select net.http_post(
   url:='https://qamdvfakwclkuswrdckp.supabase.co/functions/v1/pi-rn1-acquisition-batch',
   body:='{"action":"acquisition_batch","limit":2}'::jsonb,
   headers:=jsonb_build_object(
     'Content-Type','application/json',
     'x-pi-scheduler-token',
     (select decrypted_secret from vault.decrypted_secrets where name='pi_ingest_scheduler_token')
   ),
   timeout_milliseconds:=55000
 ) as request_id
 where exists(select 1 from pi.rn1_chain_acquisition_queue
   where audit_status='pending' and audit_attempts<3
   and (audit_lease_until is null or audit_lease_until<now()));
 $job$
);
-- Disable safely if needed: select cron.unschedule('pi-rn1-acquisition-audit-1min');
