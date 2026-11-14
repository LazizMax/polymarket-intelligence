-- Supabase-managed scheduling extensions for an isolated Polymarket job.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
