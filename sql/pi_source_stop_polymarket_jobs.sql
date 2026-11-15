-- SOURCE project: bxfvgywfiifnsbjgudzj
-- Execute only at the controlled cutover after the first pass of both
-- migrations is DONE. No source database table or Storage objects are deleted.
DO $source_cutover$
DECLARE j record;
BEGIN
 IF EXISTS (SELECT 1 FROM pi.migration_export_state WHERE status<>'done')
 OR EXISTS (SELECT 1 FROM pi.migration_table_export_state WHERE status<>'done') THEN
  RAISE EXCEPTION 'Initial migration incomplete: refuse to stop source writers';
 END IF;
 FOR j IN SELECT jobid,jobname FROM cron.job
  WHERE active AND jobname LIKE 'pi-%'
    AND jobname NOT IN ('pi-private-storage-migration-1min','pi-sql-migration-1min')
 LOOP
  PERFORM cron.alter_job(job_id:=j.jobid,active:=false);
 END LOOP;
 IF EXISTS(SELECT 1 FROM cron.job WHERE active AND jobname LIKE 'pi-%'
  AND jobname NOT IN('pi-private-storage-migration-1min','pi-sql-migration-1min')) THEN
  RAISE EXCEPTION 'A Polymarket source writer remains active';
 END IF;
END $source_cutover$;

-- After source writers are OFF, run sql/pi_final_delta_guarded_cutover.sql.
-- At no point disable unrelated Fit Tracker crons.
