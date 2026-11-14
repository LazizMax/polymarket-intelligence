-- Retire the temporary SQL HTTP bootstrap extension after the 100-wallet pilot.
-- The isolated service-only Edge Function pi-ingest is the intended ongoing ingestion path.
drop extension if exists http;
