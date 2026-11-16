-- RN1: bounded, private, causally timestamped NBA bookmaker moneylines.
-- External provider API key is never stored here. Only normalized observations are kept.
create table if not exists pi.rn1_external_odds_observations (
 id bigint generated always as identity primary key,
 provider text not null check(provider in ('theoddsapi')),
 source_event_id text not null,
 event_slug text not null,
 bookmaker text not null check(bookmaker in ('draftkings','fanduel')),
 market_type text not null default 'h2h' check(market_type='h2h'),
 home_team text not null,
 away_team text not null,
 start_at timestamptz not null,
 first_seen_at timestamptz not null,
 book_updated_at timestamptz,
 home_american integer not null check(home_american between -100000 and 100000 and home_american<>0),
 away_american integer not null check(away_american between -100000 and 100000 and away_american<>0),
 home_fair_probability double precision not null check(home_fair_probability>0 and home_fair_probability<1),
 away_fair_probability double precision not null check(away_fair_probability>0 and away_fair_probability<1),
 source_description text not null default 'TheOddsAPI NBA h2h public-book observations; API received time is causal',
 inserted_at timestamptz not null default now(),
 check(abs(home_fair_probability+away_fair_probability-1)<0.000001)
);
-- A repeated provider payload is not a new piece of evidence. Keep the first time
-- that particular odds state was actually seen by OUR system.
create unique index if not exists rn1_external_odds_provider_dedupe
 on pi.rn1_external_odds_observations
 (provider,source_event_id,bookmaker,book_updated_at,home_american,away_american) nulls not distinct;
create index if not exists rn1_external_odds_predecision
 on pi.rn1_external_odds_observations(event_slug,first_seen_at,bookmaker);
alter table pi.rn1_external_odds_observations enable row level security;
revoke all on pi.rn1_external_odds_observations from public,anon,authenticated;

create table if not exists pi.rn1_external_odds_collector_state (
 singleton smallint primary key default 1 check(singleton=1),
 provider text not null default 'theoddsapi',
 status text not null default 'missing_api_key'
   check(status in ('missing_api_key','ready','collecting','paused_cap','rate_limited','provider_error')),
 day_utc date,
 calls_today integer not null default 0 check(calls_today between 0 and 100),
 last_call_at timestamptz,
 last_success_at timestamptz,
 last_inserted integer not null default 0,
 last_error_kind text,
 updated_at timestamptz not null default now()
);
insert into pi.rn1_external_odds_collector_state(singleton) values(1) on conflict do nothing;
alter table pi.rn1_external_odds_collector_state enable row level security;
revoke all on pi.rn1_external_odds_collector_state from public,anon,authenticated;

-- Hard operational limits are implemented in the authenticated collector:
-- <= 24 calls/day, >= 50 min between requests, <= 5000 observations total.
-- There is no broad historical backfill and no paid API subscription.
