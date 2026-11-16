// Maker-first historical research: on-demand, authenticated read-only backend.
// Uses verified Maker/Taker fills and per-token active windows. No inference of
// private order-placement timestamps from execution timestamps.
export async function rn1MakerHistoricalReport(db:any) {
 const sql=String.raw;
 const [coverage,rates,heldout,eventControl,chronological,scoreStrata,inventory,bursts,bookOverlap]=await Promise.all([
  db.unsafe(`select (select count(*)::integer from pi.rn1_maker_historical_pages) pages,
    (select coalesce(sum(maker_fills),0)::integer from pi.rn1_maker_historical_pages) maker,
    (select coalesce(sum(taker_fills),0)::integer from pi.rn1_maker_historical_pages) taker,
    (select coalesce(sum(matched_price),0)::integer from pi.rn1_maker_historical_pages) price_matches,
    (select coalesce(sum(matched_score),0)::integer from pi.rn1_maker_historical_pages) score_matches,
    (select count(*)::integer from pi.rn1_full_archive_pages where stream='trades_all') archive_pages`),
  db.unsafe(`with r as (select event_slug,token_id,delta_5m,maker_fills_next_60s,
   taker_fills_next_60s from pi.rn1_maker_historical_minute_panel_v2)
   select case when delta_5m< -0.01 then 'drop' when delta_5m>0.01 then 'rise'
    else 'quiet' end regime, count(*)::integer minutes,
    count(*) filter(where maker_fills_next_60s>0)::integer maker_windows,
    count(*) filter(where taker_fills_next_60s>0)::integer taker_windows,
    round(100.0*avg((maker_fills_next_60s>0)::integer),3)::float8 maker_pct,
    round(100.0*avg((taker_fills_next_60s>0)::integer),3)::float8 taker_pct
    from r where delta_5m is not null group by 1 order by 1`),
  db.unsafe(`with labeled as (
   select event_slug,mod(('x'||substr(md5(event_slug),1,8))::bit(32)::bigint,5) fold,
   case when abs(delta_5m)>0.01 then 'volatile' else 'quiet' end regime,
   (maker_fills_next_60s>0)::integer y
   from pi.rn1_maker_historical_minute_panel_v2 where delta_5m is not null
   ), agg as (select fold,regime,count(*) n,sum(y) positives from labeled group by 1,2),
   tot as (select sum(n) n,sum(positives) positives from agg),
   folds as (select fold,sum(n) n,sum(positives) positives from agg group by fold),
   regimes as (select regime,sum(n) n,sum(positives) positives from agg group by regime),
   predictions as (select agg.*,
      greatest(.00001,least(.99999,(tot.positives-folds.positives+1.0)/(tot.n-folds.n+2.0))) base_p,
      greatest(.00001,least(.99999,(regimes.positives-agg.positives+1.0)/(regimes.n-agg.n+2.0))) volatility_p
      from agg join folds using(fold) join regimes using(regime) cross join tot
   )
   select sum(n)::integer minutes,sum(positives)::integer positives,
    round((sum(-positives*ln(base_p)-(n-positives)*ln(1-base_p))/sum(n))::numeric,6)::float8 baseline_logloss,
    round((sum(-positives*ln(volatility_p)-(n-positives)*ln(1-volatility_p))/sum(n))::numeric,6)::float8 volatility_logloss
   from predictions`),
  db.unsafe(`with by_event as (
   select event_slug,
   avg((maker_fills_next_60s>0)::integer) filter(where abs(delta_5m)>0.01) volatile_rate,
   avg((maker_fills_next_60s>0)::integer) filter(where abs(delta_5m)<=0.01) calm_rate,
   count(*) filter(where abs(delta_5m)>0.01) volatile_minutes,
   count(*) filter(where abs(delta_5m)<=0.01) calm_minutes
   from pi.rn1_maker_historical_minute_panel_v2 where delta_5m is not null group by event_slug
  )
  select count(*) filter(where volatile_minutes>=20 and calm_minutes>=20)::integer comparable_events,
  count(*) filter(where volatile_minutes>=20 and calm_minutes>=20 and volatile_rate>calm_rate)::integer volatile_more,
  count(*) filter(where volatile_minutes>=20 and calm_minutes>=20 and volatile_rate<calm_rate)::integer calm_more,
  round(avg(volatile_rate-calm_rate) filter(where volatile_minutes>=20 and calm_minutes>=20)::numeric,5)::float8 event_mean_diff
  from by_event`),
  db.unsafe(`with event_start as (
    select event_slug,min(minute_at) first_at
    from pi.rn1_maker_historical_minute_panel_v2 where delta_5m is not null group by 1
   ), ranked as (
    select event_slug,first_at,row_number() over(order by first_at,event_slug) rk,count(*) over() ne from event_start
   ), labeled as (
    select case when r.rk<=floor(r.ne*.7) then 'train' else 'test' end split,
     case when abs(p.delta_5m)>0.01 then 'volatile' else 'quiet' end regime,
     (p.maker_fills_next_60s>0)::integer y
    from pi.rn1_maker_historical_minute_panel_v2 p join ranked r using(event_slug)
    where p.delta_5m is not null
   ), groups as (select split,regime,count(*) n,sum(y) yes from labeled group by 1,2),
   train as (select sum(n) n,sum(yes) yes from groups where split='train'),
   tr as (select regime,sum(n) n,sum(yes) yes from groups where split='train' group by 1),
   test as (
    select g.n,g.yes,
      greatest(.00001,least(.99999,(train.yes+1.0)/(train.n+2.0))) pbase,
      greatest(.00001,least(.99999,(tr.yes+1.0)/(tr.n+2.0))) pregime
    from groups g join tr using(regime) cross join train where g.split='test'
   )
   select (select count(*)::integer from ranked) events,
     (select count(*)::integer from ranked where rk<=floor(ne*.7)) train_events,
     (select count(*)::integer from ranked where rk>floor(ne*.7)) test_events,
     sum(n)::integer test_minutes,sum(yes)::integer positives,
     round((sum(-yes*ln(pbase)-(n-yes)*ln(1-pbase))/sum(n))::numeric,6)::float8 baseline_logloss,
     round((sum(-yes*ln(pregime)-(n-yes)*ln(1-pregime))/sum(n))::numeric,6)::float8 volatility_logloss
   from test`),
  db.unsafe(`with w as (
    select p.event_slug,p.token_id,p.minute_at,p.delta_5m,(p.maker_fills_next_60s>0)::integer maker,
     exists(select 1 from pi.rn1_nba_espn_plays e
      where e.event_slug=p.event_slug and e.is_scoring=true
       and e.play_at<=p.minute_at
       and e.play_at>p.minute_at-interval '60 seconds') scoring_last_minute
    from pi.rn1_maker_historical_minute_panel_v2 p where p.delta_5m is not null
   )
   select scoring_last_minute,
    case when abs(delta_5m)>0.01 then 'volatile' else 'quiet' end regime,
    count(*)::integer minutes,sum(maker)::integer maker_windows,
    round(100.0*avg(maker),3)::float8 maker_pct
   from w group by 1,2 order by 1,2`),
  db.unsafe(`with minute_net as (
    select market_key,date_trunc('minute',trade_at) minute_at,
     sum(case when outcome_index=0 and side='BUY' then shares when outcome_index=0 and side='SELL' then -shares else 0 end) dq0,
     sum(case when outcome_index=1 and side='BUY' then shares when outcome_index=1 and side='SELL' then -shares else 0 end) dq1
    from pi.rn1_maker_historical_fills group by 1,2
   ), pre as (
    select market_key,minute_at,
      coalesce(sum(dq0) over(partition by market_key order by minute_at rows between unbounded preceding and 1 preceding),0) q0,
      coalesce(sum(dq1) over(partition by market_key order by minute_at rows between unbounded preceding and 1 preceding),0) q1
    from minute_net
   ), eligible as (
    select f.market_key,f.event_slug,
     case when f.outcome_index=0 then p.q0<p.q1 else p.q1<p.q0 end underweight,
     case when f.outcome_index=0 then p.q0=p.q1 else p.q1=p.q0 end equal_sides
    from pi.rn1_maker_historical_fills f join pre p
      on p.market_key=f.market_key and p.minute_at=date_trunc('minute',f.trade_at)
    where f.role='maker' and f.side='BUY' and p.q0>0 and p.q1>0
   ), markets as (
    select market_key,count(*) n,avg(underweight::integer) underweight_rate
    from eligible group by market_key
   )
   select (select count(*)::integer from eligible) eligible_maker_buys,
     (select count(*)::integer from eligible where underweight) underweight_buys,
     (select count(*)::integer from eligible where equal_sides) neutral_buys,
     (select count(*)::integer from markets where n>=10) markets_10plus,
     (select round(avg(underweight_rate) filter(where n>=10)::numeric,4)::float8 from markets) mean_market_underweight_rate,
     (select count(*)::integer from markets where n>=10 and underweight_rate>0.5) markets_underweight_more,
     (select count(*)::integer from markets where n>=10 and underweight_rate<0.5) markets_overweight_more`),
 db.unsafe(`select role,count(*)::integer bursts,sum(fill_count)::integer fills,
   count(*) filter(where fill_count>1)::integer multi_bursts,
   coalesce(sum(fill_count) filter(where fill_count>1),0)::integer fills_in_multi,
   max(fill_count)::integer max_fills_in_burst,
   round(avg(fill_count),3)::float8 mean_fills_per_burst
  from pi.rn1_maker_historical_bursts group by role order by role`),
 db.unsafe(`select
   (select count(distinct token_id)::integer from pi.rn1_maker_historical_fills) archived_tokens,
   (select count(distinct token_id)::integer from pi.rn1_quote_probe_fills) probed_tokens,
   (select count(distinct h.token_id)::integer from pi.rn1_maker_historical_fills h
       where exists(select 1 from pi.rn1_quote_probe_fills p where p.token_id=h.token_id)) token_overlap,
   (select min(received_at)::text from pi.rn1_quote_probe_runs) first_live_book_at,
   (select max(trade_at)::text from pi.rn1_maker_historical_fills) last_cohort_fill_at`)
 ]);
 return {status:"exploratory",source:"verified_full_archive",cohort:coverage[0]||{},
 regimes:rates,heldout:heldout[0]||{},event_control:eventControl[0]||{}, chronological:chronological[0]||{},score_strata:scoreStrata,inventory:inventory[0]||{},bursts,book_overlap:bookOverlap[0]||{},
 limitations:[
 "Maker describes executed role, not placement/cancellation of a private order.",
 "A burst is same-token, same-side, same-price contiguous execution (<=1 second apart), not a verified parent order.",
 "The price series is Polymarket indicative history, not archived bid/ask.",
 "Only minutes bounded by observed first and last fills per token are eligible; controls remain selected.",
 "ESPN play timestamps are retrospective and do not establish RN1 information arrival.",
 "No fee, queue, slippage, causal identification or trading EV is estimated."
 ]};
}
