-- RN1 large maker/taker replay, live migration already applied to the Fit Tracker Supabase project.
-- Private progress table; sources and detailed checkpoints stay in pi-rn1-research-private.
CREATE TABLE IF NOT EXISTS pi.rn1_replay_jobs (
 job_key text PRIMARY KEY,
 status text NOT NULL DEFAULT 'running'
  CHECK (status IN ('running','complete','paused_error','paused_quota')),
 frozen_last_page bigint NOT NULL CHECK(frozen_last_page>0),
 next_page bigint NOT NULL CHECK(next_page>=0),
 pages_done bigint NOT NULL DEFAULT 0,
 fills_done bigint NOT NULL DEFAULT 0,
 maker_fills bigint NOT NULL DEFAULT 0,
 taker_fills bigint NOT NULL DEFAULT 0,
 unknown_fills bigint NOT NULL DEFAULT 0,
 snapshot_key text,
 summary jsonb NOT NULL DEFAULT '{}'::jsonb,
 lease_until timestamptz,
 last_success_at timestamptz,
 completed_at timestamptz,
 last_error text,
 error_attempts integer NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pi.rn1_replay_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pi.rn1_replay_jobs FROM anon,authenticated;
CREATE TABLE IF NOT EXISTS pi.rn1_replay_pages (
 page_no bigint PRIMARY KEY,
 source_sha256 text NOT NULL,
 maker_fills integer NOT NULL DEFAULT 0,
 taker_fills integer NOT NULL DEFAULT 0,
 unknown_fills integer NOT NULL DEFAULT 0,
 valid_fills integer NOT NULL DEFAULT 0,
 role_quality text NOT NULL,
 snapshot_key text NOT NULL,
 processed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pi.rn1_replay_pages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pi.rn1_replay_pages FROM anon,authenticated;
-- Cohort frozen at bootstrap; do NOT reset on deploy.
INSERT INTO pi.rn1_replay_jobs(job_key,frozen_last_page,next_page)
SELECT 'rn1_full_chronology_v1',max(page_no),max(page_no)
FROM pi.rn1_full_archive_pages WHERE stream='trades_all'
HAVING max(page_no)>0
ON CONFLICT(job_key) DO NOTHING;
