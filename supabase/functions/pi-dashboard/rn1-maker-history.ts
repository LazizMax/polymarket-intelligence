// Maker-first historical research: on-demand, authenticated read-only backend.
// Uses verified Maker/Taker fills and per-token active windows. No inference of
// private order-placement timestamps from execution timestamps.
export async function rn1MakerHistoricalReport(db:any) {
 const sql=String.raw;
 const [coverage,rates,heldout,eventControl]=await Promise.all([
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
  from by_event`)
 ]);
 return {status:"exploratory",source:"verified_full_archive",cohort:coverage[0]||{},
 regimes:rates,heldout:heldout[0]||{},event_control:eventControl[0]||{},
 limitations:[
 "Maker describes executed role, not placement/cancellation of a private order.",
 "The price series is Polymarket indicative history, not archived bid/ask.",
 "Only minutes bounded by observed first and last fills per token are eligible; controls remain selected.",
 "ESPN play timestamps are retrospective and do not establish RN1 information arrival.",
 "No fee, queue, slippage, causal identification or trading EV is estimated."
 ]};
}
