-- Immutable-ish native Polymarket public wallet PnL observations.
-- Retain every public source atom: numeric precision must not be rounded in JS.
-- Use private pi schema, RLS, and no browser-readable SELECT grants.
CREATE TABLE IF NOT EXISTS pi.rn1_official_pnl_points(
 wallet text NOT NULL CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
 observed_at timestamptz NOT NULL,
 source_block bigint,
 record jsonb NOT NULL CHECK (jsonb_typeof(record)='object'),
 fetched_at timestamptz NOT NULL DEFAULT now(),
 source_endpoint text NOT NULL DEFAULT '/v2/user-pnl?interval=all&fidelity=1d',
 PRIMARY KEY(wallet,observed_at)
);
ALTER TABLE pi.rn1_official_pnl_points ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pi.rn1_official_pnl_points FROM anon,authenticated;
CREATE INDEX IF NOT EXISTS idx_pi_rn1_official_pnl_wallet_date ON pi.rn1_official_pnl_points(wallet,observed_at DESC);
