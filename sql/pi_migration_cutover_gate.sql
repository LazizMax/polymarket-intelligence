-- Destination only. Create once before final verification.
-- DO NOT mark verified=true until first pass and final delta sweeps are
-- complete, old writers are OFF, all table/Storage SHA comparisons pass,
-- dashboard login and Vault privacy tests pass, and zero critical drift.
CREATE TABLE IF NOT EXISTS pi.migration_cutover_readiness(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 verified boolean NOT NULL DEFAULT false,
 verified_at timestamptz,
 summary jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE pi.migration_cutover_readiness ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pi.migration_cutover_readiness FROM anon,authenticated;
INSERT INTO pi.migration_cutover_readiness(singleton,verified)
 VALUES(true,false) ON CONFLICT(singleton) DO NOTHING;
