-- Additional index found by Supabase performance advisors.
create index if not exists idx_pi_ingestion_wallet on pi.ingestion_jobs(wallet) where wallet is not null;
