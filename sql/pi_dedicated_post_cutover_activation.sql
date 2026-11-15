-- DESTINATION project: qamdvfakwclkuswrdckp
-- Execute ONLY after source jobs have been stopped, second SQL and Storage
-- delta sweeps completed, and independent source/destination hashes verified.
-- Markers are intentionally absent until the operator completes verification.
-- Never run this migration during the initial transfer.

DO $destination_cutover$
DECLARE j record;
DECLARE verified boolean;
BEGIN
 SELECT EXISTS(SELECT 1 FROM pi.migration_cutover_readiness
   WHERE singleton=true AND verified=true AND verified_at>now()-interval '2 hours')
 INTO verified;
 IF NOT verified THEN
  RAISE EXCEPTION 'Refuse activation: recent external data-integrity verification missing';
 END IF;
 IF (SELECT count(*) FROM pi.external_dashboard_access WHERE enabled)<1 THEN
  RAISE EXCEPTION 'Refuse activation: no authorised legacy-Auth identity';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM storage.objects
   WHERE bucket_id='pi-rn1-research-private'
     AND name=(SELECT snapshot_key FROM pi.rn1_replay_jobs
      WHERE job_key='rn1_full_chronology_v1')) THEN
  RAISE EXCEPTION 'Refuse activation: replay checkpoint absent';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM storage.objects
   WHERE bucket_id='pi-rn1-research-private'
     AND name=(SELECT checkpoint_key FROM pi.rn1_independent_price_jobs
      WHERE job_key='rn1_independent_price_v1')) THEN
  RAISE EXCEPTION 'Refuse activation: independent price checkpoint absent';
 END IF;
 IF pg_database_size(current_database())>805306368 THEN
  RAISE EXCEPTION 'Refuse activation: dedicated database exceeds 768 MiB headroom gate';
 END IF;
 -- Set counters of existing identities so new inserts cannot reuse migrated ids.
 PERFORM setval('pi.arb_temporal_snapshots_snapshot_id_seq',
  GREATEST(1,(SELECT coalesce(max(snapshot_id),0) FROM pi.arb_temporal_snapshots)),
  EXISTS(SELECT 1 FROM pi.arb_temporal_snapshots));
 PERFORM setval('pi.ingestion_jobs_id_seq',
  GREATEST(1,(SELECT coalesce(max(id),0) FROM pi.ingestion_jobs)),
  EXISTS(SELECT 1 FROM pi.ingestion_jobs));
 PERFORM setval('pi.rn1_quote_probe_runs_id_seq',
  GREATEST(1,(SELECT coalesce(max(id),0) FROM pi.rn1_quote_probe_runs)),
  EXISTS(SELECT 1 FROM pi.rn1_quote_probe_runs));

 UPDATE pi.rn1_replay_jobs SET status='running',last_error=null,
  error_attempts=0,lease_until=null,updated_at=now()
  WHERE job_key='rn1_full_chronology_v1' AND status='paused_quota';
 UPDATE pi.rn1_independent_price_jobs SET status='running',
  last_error=null,error_attempts=0,lease_until=null,updated_at=now()
  WHERE job_key='rn1_independent_price_v1' AND status='paused_quota';
 -- Lift only destination historical-materialization limits. Without this,
 -- streams would archive newer source pages but silently stop aggregating RN1
 -- market statistics after the legacy shared-DB threshold is reached.
 UPDATE pi.rn1_full_streams
 SET max_db_bytes=1073741824,last_error=null,
     status=case when status='paused_quota' then 'collecting' else status end,
     lease_until=null,updated_at=now()
 WHERE stream IN ('activity_all','trades_all');
 UPDATE pi.rn1_quote_probe_state SET status='collecting',
  max_db_bytes=1073741824,lease_until=null,last_error=null
  WHERE singleton=true AND status='paused_quota';
 -- RN1 archive streams are already collecting on the source; do not reset
 -- pages_fetched or historical cursor. Newly added old-history pages were
 -- included in the final delta sweep.
 FOR j IN SELECT jobid,jobname FROM cron.job WHERE jobname LIKE 'pi-%'
 LOOP
  PERFORM cron.alter_job(job_id:=j.jobid,active:=true);
 END LOOP;
END $destination_cutover$;

-- After two clean collection cycles and auth/API validation, switch GitHub
-- Pages to the dedicated backend. Retain original tables and Storage for rollback.
