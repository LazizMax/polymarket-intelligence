-- RN1 ESPN NBA causal-time evidence. Applied in dedicated Supabase project.
-- Files 058b/058c are ordered before 059's scheduler.
create table if not exists pi.rn1_nba_espn_links(
 event_slug text primary key,game_day date not null,espn_event_id text,
 scoreboard_at timestamptz,event_name text,
 status text not null default 'pending'
   check(status in('pending','working','complete','missing','error')),
 attempts integer not null default 0,last_error text,lease_until timestamptz,
 summary_sha256 text,first_play_at timestamptz,last_play_at timestamptz,
 plays_seen integer not null default 0,plays_timed integer not null default 0,
 scoring_plays integer not null default 0,fetched_at timestamptz,
 updated_at timestamptz not null default now()
);
create index if not exists rn1_nba_espn_links_pending_idx
 on pi.rn1_nba_espn_links(status,game_day desc,attempts);
create table if not exists pi.rn1_nba_espn_scoreboards(
 game_day date primary key,games jsonb not null,
 fetched_at timestamptz not null default now(),
 source text not null default 'ESPN site.web.api.espn.com NBA scoreboard'
);
create table if not exists pi.rn1_nba_espn_plays(
 event_slug text not null references pi.rn1_nba_espn_links(event_slug),
 play_id text not null,espn_event_id text not null,play_at timestamptz not null,
 sequence_number bigint,period_number smallint,clock_text text,
 home_score smallint,away_score smallint,points smallint,
 is_scoring boolean not null default false,play_type text,play_text text,
 recorded_at timestamptz not null default now(),
 primary key(event_slug,play_id)
);
create index if not exists rn1_nba_espn_plays_time_idx
 on pi.rn1_nba_espn_plays(event_slug,play_at,sequence_number);
insert into pi.rn1_nba_espn_links(event_slug,game_day)
select distinct event_slug,substring(event_slug from '[0-9]{4}-[0-9]{2}-[0-9]{2}$')::date
from pi.rn1_pattern_market_entries
where event_slug~'^nba-[a-z]{2,4}-[a-z]{2,4}-2026-11-(09|10|11|12|13|14|15)$'
on conflict do nothing;
do $$
declare t text;
begin
 foreach t in array array['rn1_nba_espn_links','rn1_nba_espn_scoreboards','rn1_nba_espn_plays'] loop
  execute format('alter table pi.%I enable row level security',t);
  execute format('revoke all on table pi.%I from anon,authenticated',t);
 end loop;
end $$;
