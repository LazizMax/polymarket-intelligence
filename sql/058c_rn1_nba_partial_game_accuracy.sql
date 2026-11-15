-- In-progress matches must not be labelled as fully observed games.
alter table pi.rn1_nba_espn_links drop constraint if exists rn1_nba_espn_links_status_check;
alter table pi.rn1_nba_espn_links
 add constraint rn1_nba_espn_links_status_check
 check(status in('pending','working','complete','partial','missing','error'));
update pi.rn1_nba_espn_links l set status='partial'
where l.status='complete' and exists(
 select 1 from pi.rn1_nba_espn_scoreboards s
 cross join lateral jsonb_array_elements(s.games) g
 where s.game_day=l.game_day and g->>'id'=l.espn_event_id
 and coalesce((g->'status'->'type'->>'completed')::boolean,false)=false
);
