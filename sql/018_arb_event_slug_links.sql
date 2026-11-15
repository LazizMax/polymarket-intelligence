-- Event-level URLs are distinct from individual market slugs on multi-market Polymarket events.
-- Preserve market_slug as provenance, add canonical event_slug exclusively for /event/{slug} links.
alter table pi.arb_temporal_snapshots
 add column if not exists event_slug text;

comment on column pi.arb_temporal_snapshots.event_slug is
 'Canonical Gamma events[0].slug for polymarket.com/event/{slug}; NULL if not supplied';
