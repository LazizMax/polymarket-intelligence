-- Automated bounded ESPN backfill for NBA games relevant to RN1; private Vault auth.
-- No RPC trading actions or user-facing keys.
select cron.schedule(
 'pi-rn1-nba-espn-events-1min',
 '* * * * *',
 $job$
 select net.http_post(
   url:='https://qamdvfakwclkuswrdckp.supabase.co/functions/v1/pi-rn1-sports-events',
   body:='{"action":"nba_event_sync","count":4}'::jsonb,
   headers:=jsonb_build_object(
     'Content-Type','application/json',
     'x-pi-scheduler-token',
       (select decrypted_secret from vault.decrypted_secrets where name='pi_ingest_scheduler_token')
   ),
   timeout_milliseconds:=60000
 )
 where exists(
  select 1 from pi.rn1_nba_espn_links
  where status in ('pending','error') or (status='working' and lease_until<now())
 );
 $job$
);
