-- Historical RN1 strategy setup research; isolated private schema.
-- Raw fills remain exclusively in the existing private gzip archives.
CREATE TABLE IF NOT EXISTS pi.rn1_event_schedule (
 event_slug text PRIMARY KEY,
 event_fills bigint NOT NULL DEFAULT 0,
 market_count integer NOT NULL DEFAULT 0,
 selection text NOT NULL DEFAULT 'top_activity',
 start_at timestamptz,
 source_start_at timestamptz,
 start_source text,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','working','ok','missing','error')),
 attempts int NOT NULL DEFAULT 0,
 fetched_at timestamptz,
 lease_until timestamptz,
 last_error text
);
CREATE INDEX IF NOT EXISTS rn1_event_schedule_pending_idx ON pi.rn1_event_schedule(status,event_fills DESC);
CREATE TABLE IF NOT EXISTS pi.rn1_pattern_jobs(
 job_key text PRIMARY KEY,
 status text NOT NULL DEFAULT 'running' CHECK(status IN('running','complete','paused','error')),
 frozen_last_page integer NOT NULL DEFAULT 756,
 next_page integer NOT NULL DEFAULT 1,
 pages_done integer NOT NULL DEFAULT 0,
 fills_done bigint NOT NULL DEFAULT 0,
 lease_until timestamptz,
 last_error text,
 last_success_at timestamptz,
 completed_at timestamptz
);
INSERT INTO pi.rn1_pattern_jobs(job_key,frozen_last_page,next_page)
 VALUES('rn1_fill_setup_756k_v1',756,1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS pi.rn1_pattern_page_stats(
 page_no integer PRIMARY KEY,
 source_sha256 text NOT NULL,
 fills integer NOT NULL,
 buys integer NOT NULL,
 sells integer NOT NULL,
 summary jsonb NOT NULL,
 processed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pi.rn1_pattern_market_entries(
 market_key text PRIMARY KEY,
 event_slug text,
 first_at timestamptz NOT NULL,
 first_side smallint NOT NULL CHECK(first_side IN(0,1)),
 first_price numeric NOT NULL,
 first_qty numeric NOT NULL,
 first0_at timestamptz, first1_at timestamptz,
 first0_price numeric,first1_price numeric,
 last_at timestamptz NOT NULL,
 fills bigint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS rn1_pattern_market_entries_event_idx ON pi.rn1_pattern_market_entries(event_slug);
CREATE INDEX IF NOT EXISTS rn1_pattern_market_entries_first_idx ON pi.rn1_pattern_market_entries(first_at);
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['rn1_event_schedule','rn1_pattern_jobs','rn1_pattern_page_stats','rn1_pattern_market_entries'] LOOP
  EXECUTE format('ALTER TABLE pi.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE pi.%I FROM anon, authenticated',t);
 END LOOP;
END $$;
