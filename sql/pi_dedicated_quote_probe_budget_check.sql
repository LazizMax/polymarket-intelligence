-- Dedicated Polymarket project only; do not apply on shared Fit Tracker.
-- The previous 512MiB per-quote-probe safety ceiling was specific to the
-- shared database. Dedicated research is guarded at 1GiB separately.
ALTER TABLE pi.rn1_quote_probe_state
 DROP CONSTRAINT rn1_quote_probe_state_max_db_bytes_check;
ALTER TABLE pi.rn1_quote_probe_state
 ADD CONSTRAINT rn1_quote_probe_state_max_db_bytes_check
 CHECK (max_db_bytes BETWEEN 209715200 AND 1073741824);