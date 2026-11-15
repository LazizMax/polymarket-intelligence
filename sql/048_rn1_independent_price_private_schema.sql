-- Applied to project bxfvgywfiifnsbjgudzj (private pi schema).
CREATE TABLE IF NOT EXISTS pi.rn1_independent_price_jobs (
 job_key text PRIMARY KEY,
 status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','complete','paused_error','paused_quota')),
 frozen_last_page bigint NOT NULL CHECK(frozen_last_page>0),
 next_page bigint NOT NULL CHECK(next_page>=0),
 pages_done bigint NOT NULL DEFAULT 0,
 source_fills bigint NOT NULL DEFAULT 0,
 sampled_buy_fills bigint NOT NULL DEFAULT 0,
 sampled_maker_fills bigint NOT NULL DEFAULT 0,
 sampled_taker_fills bigint NOT NULL DEFAULT 0,
 sampled_unknown_fills bigint NOT NULL DEFAULT 0,
 checkpoint_key text,
 summary jsonb NOT NULL DEFAULT '{}'::jsonb,
 lease_until timestamptz,
 last_success_at timestamptz,
 completed_at timestamptz,
 last_error text,
 error_attempts integer NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pi.rn1_independent_price_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pi.rn1_independent_price_jobs FROM anon,authenticated;
CREATE TABLE IF NOT EXISTS pi.rn1_independent_price_pages (
 page_no bigint PRIMARY KEY,
 source_sha256 text NOT NULL,
 min_trade_at timestamptz,
 max_trade_at timestamptz,
 sampled_tokens integer NOT NULL,
 sampled_buy_fills integer NOT NULL,
 sample_market_count integer NOT NULL,
 sample_event_slugs jsonb NOT NULL DEFAULT '[]'::jsonb,
 history_requests integer NOT NULL,
 history_success integer NOT NULL,
 matched_by_horizon jsonb NOT NULL DEFAULT '{}'::jsonb,
 summary jsonb NOT NULL DEFAULT '{}'::jsonb,
 checkpoint_key text NOT NULL,
 processed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pi.rn1_independent_price_pages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pi.rn1_independent_price_pages FROM anon,authenticated;
INSERT INTO pi.rn1_independent_price_jobs(job_key,frozen_last_page,next_page)
SELECT 'rn1_independent_price_v1',frozen_last_page,frozen_last_page
FROM pi.rn1_replay_jobs WHERE job_key='rn1_full_chronology_v1'
ON CONFLICT(job_key) DO NOTHING;
