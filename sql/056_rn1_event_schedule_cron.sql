select cron.schedule(
 'pi-rn1-event-schedule-enrich-10s','10 seconds',
 $job$
 select net.http_post(
 url:='https://qamdvfakwclkuswrdckp.supabase.co/functions/v1/pi-rn1-event-schedule',
 body:='{"action":"enrich_rn1_events","count":15}'::jsonb,
 headers:=jsonb_build_object('Content-Type','application/json','x-pi-scheduler-token',
  (select decrypted_secret from vault.decrypted_secrets where name='pi_ingest_scheduler_token')),
 timeout_milliseconds:=60000)
 where exists(select 1 from pi.rn1_event_schedule
  where status='pending' or (status='working' and lease_until<now()));
 $job$
);