-- Full RN1 public wallet history collection. Unlike the 4k pilot, no arbitrary
-- row limit. Each run requests at most 2x1,000 rows per source stream.
-- Self-limiting: only run while status='collecting', and each worker stops on DB/Storage budgets.
-- Private Vault-backed scheduler token only; no user trading credentials.
select cron.schedule(
 'pi-rn1-full-trades-2min',
 '*/2 * * * *',
 $$
 select net.http_post(
  url:='https://bxfvgywfiifnsbjgudzj.supabase.co/functions/v1/pi-ingest',
  body:='{"action":"rn1_full_archive_scheduled","stream":"trades_all"}'::jsonb,
  headers:=jsonb_build_object(
   'Content-Type','application/json',
   'x-pi-scheduler-token',(select decrypted_secret from vault.decrypted_secrets where name='pi_ingest_scheduler_token')),
  timeout_milliseconds:=60000
 )
 where exists (select 1 from pi.rn1_full_streams where stream='trades_all' and status='collecting');
 $$
);
select cron.schedule(
 'pi-rn1-full-activity-2min',
 '*/2 * * * *',
 $$
 select net.http_post(
  url:='https://bxfvgywfiifnsbjgudzj.supabase.co/functions/v1/pi-ingest',
  body:='{"action":"rn1_full_archive_scheduled","stream":"activity_all"}'::jsonb,
  headers:=jsonb_build_object(
   'Content-Type','application/json',
   'x-pi-scheduler-token',(select decrypted_secret from vault.decrypted_secrets where name='pi_ingest_scheduler_token')),
  timeout_milliseconds:=60000
 )
 where exists (select 1 from pi.rn1_full_streams where stream='activity_all' and status='collecting');
 $$
);
-- Separate from the ROI, arb, and existing RN1 pilot cron jobs; no unrelated changes.
-- Stop collection immediately by setting status='paused_quota' for both streams.
