-- Run ONLY on the SOURCE Fit Tracker project, after all original
-- Polymarket writers have been disabled and the FIRST migration pass
-- has fully completed. Do NOT execute while live collectors continue.
-- This is deliberately stored for a *future guarded cutover*, NOT yet executed.
DO $cutover$
BEGIN
 IF EXISTS (
  SELECT 1 FROM cron.job
  WHERE active
   AND jobname LIKE 'pi-%'
   AND jobname NOT IN ('pi-private-storage-migration-1min','pi-sql-migration-1min')
 ) THEN
  RAISE EXCEPTION 'Refusing final delta: legacy Polymarket cron jobs still active';
 END IF;
 IF EXISTS (SELECT 1 FROM pi.migration_table_export_state WHERE status<>'done') THEN
  RAISE EXCEPTION 'Refusing final delta: initial SQL transfer incomplete';
 END IF;
 IF EXISTS (SELECT 1 FROM pi.migration_export_state WHERE status<>'done') THEN
  RAISE EXCEPTION 'Refusing final delta: initial Storage transfer incomplete';
 END IF;
 IF EXISTS (SELECT 1 FROM pi.migration_table_export_state WHERE lease_until>now())
    OR EXISTS (SELECT 1 FROM pi.migration_export_state WHERE lease_until>now()) THEN
  RAISE EXCEPTION 'Refusing final delta: migration leases still active';
 END IF;
 UPDATE pi.migration_table_export_state
 SET status='ready',cursor_pk=null,sweep_no=sweep_no+1,
     lease_until=null,last_error=null,error_attempts=0,updated_at=now();
 UPDATE pi.migration_export_state
 SET status='ready',object_cursor='',sweep_no=sweep_no+1,
     lease_until=null,last_error=null,error_attempts=0,updated_at=now();
END $cutover$;

-- The existing two migration crons will now repeat the complete transfer.
-- Upserts use the PRIMARY KEY; source batch identity includes row contents
-- to permit changed rows in final delta. Storage objects are immutable;
-- the receiver verifies object content SHA256 before deduplication.
--
-- AFTER both jobs again say done, verify:
--   * 38 source/destination table row counts and full content digests;
--   * existence, size and SHA256 of every private object/checkpoint;
--   * RN1 archive page numbers/sha256 and 100 wallet ROI states;
--   * generated identity sequences set to MAX(current id);
--   * all required functions, Vault auth, preview dashboard and RLS;
--   * only then activate the 10 dormant destination cron jobs.
-- DO NOT switch GitHub Pages or remove Fit Tracker PI data until this is green.
