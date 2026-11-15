-- Reproducible, conservative title/league taxonomy for RN1 research.
-- Prefixes not on the evidence-backed league list remain "Autres / non classé".
CREATE OR REPLACE FUNCTION pi.rn1_sport_group(event_slug text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog
AS $$
 SELECT CASE
 WHEN split_part(coalesce(event_slug,''),'-',1)=ANY(ARRAY[
  'atp','wta','itf','ch','utr','challenger','challengers','tennis']) THEN 'Tennis'
 WHEN split_part(coalesce(event_slug,''),'-',1)=ANY(ARRAY[
  'cs2','lol','dota2','val','valorant','ow2','r6','dota','rl','esports']) THEN 'Esport'
 WHEN split_part(coalesce(event_slug,''),'-',1)=ANY(ARRAY[
  'nfl','cfb','cfl','ncaaf']) THEN 'Football américain'
 WHEN split_part(coalesce(event_slug,''),'-',1)=ANY(ARRAY[
  'nba','wnba','ncaab','cbb','euroleague','euro','acb']) THEN 'Basketball'
 WHEN split_part(coalesce(event_slug,''),'-',1)=ANY(ARRAY[
  'mlb','npb','kbo']) THEN 'Baseball'
 WHEN split_part(coalesce(event_slug,''),'-',1)=ANY(ARRAY[
  'nhl','khl','ahl']) THEN 'Hockey'
 WHEN split_part(coalesce(event_slug,''),'-',1)=ANY(ARRAY[
  'ufc','mma','boxing','box','pfl']) THEN 'Sports de combat'
 WHEN split_part(coalesce(event_slug,''),'-',1)=ANY(ARRAY[
  'epl','lal','sea','ucl','uel','unl','bun','bun2','bl2','fl1','fl2',
  'bra','bra2','arg','mex','por','elc','ere','col','col1','spl','efl',
  'pol','tur','nor','fif','liga','ita','fr1','esp','fifawc','ek','uclq',
  'es2','clf','uwcl','swe','acle','chi','den','brco','bel1','jap','scop',
  'tur2','argpn','el1','lib','fr2','ned2','itsb','fin1','sud','sui',
  'rou1','idn1','ecu1','itc','afcq','chi2','dfb','chi1','enl',
  'scot','fra','ger','nor1','sw1','den1','frc','copa','worldcup',
  'ecl','uclw','eng','jpn','ned','bel','con','copa','mex2']) THEN 'Football'
 ELSE 'Autres / non classé'
 END;
$$;
CREATE OR REPLACE FUNCTION pi.rn1_market_group(market_title text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog
AS $$
 SELECT CASE
 WHEN coalesce(market_title,'') ~* 'exact score|correct score' THEN 'Score exact'
 WHEN coalesce(market_title,'') ~* '1st half|1h |first half|halftime|half.time'
   THEN 'Mi-temps / 1H'
 WHEN coalesce(market_title,'') ~* 'map [0-9]+|maps total|map handicap|rounds handicap|rounds total|rounds o/u'
   THEN 'Cartes/manches esport'
 WHEN coalesce(market_title,'') ~* 'spread|handicap' THEN 'Handicap / spread'
 WHEN coalesce(market_title,'') ~* 'both teams to score|btts' THEN 'Les deux équipes marquent'
 WHEN coalesce(market_title,'') ~* 'o/u|over/under|games total|total rounds|total games|total goals|total points'
   THEN 'Over/Under'
 WHEN coalesce(market_title,'') ~* 'draw\?|end in a draw|to end in a draw' THEN 'Match nul'
 WHEN coalesce(market_title,'') ~* 'vs\.| vs |will .* win|winner' THEN 'Vainqueur / moneyline'
 ELSE 'Autre type' END;
$$;
REVOKE ALL ON FUNCTION pi.rn1_sport_group(text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION pi.rn1_market_group(text) FROM PUBLIC,anon,authenticated;
