-- Materialize a bounded, reproducible RN1 benchmark over token histories already collected.
-- The 60-second price buckets must END at or before the trade timestamp.
-- A reference is accepted only when its bucket ends no more than 120 seconds before the trade.
-- The +15 min markout is only used when the bucket completes before official resolution.
with base as materialized(
 select t.wallet,t.trade_key,t.market_key,t.token_id,t.reported_at,t.shares,t.price,
   extract(epoch from t.reported_at)::bigint ts,
   r.resolved_at,extract(epoch from r.resolved_at)::bigint resolution_ts,
   (r.payouts->>(t.outcome_index::integer))::numeric/1000000 as payout
 from pi.trades t
 join pi.rn1_price_history_evidence source on source.token_id=t.token_id
 join pi.rn1_resolution_evidence r on r.market_key=t.market_key
 where t.wallet='0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
   and t.side='BUY'
   and r.status='resolved'
   and jsonb_typeof(r.payouts)='array'
   and jsonb_array_length(r.payouts)=2
   and (r.payouts->>0)::numeric+(r.payouts->>1)::numeric=1000000
   and t.reported_at<r.resolved_at
), observations as (
 select t.*,
   p0.price reference_price,p0.observed_epoch reference_epoch,
   p0.resolution_seconds reference_width_seconds,
   p5.price prior_5m_price,
   p15.price after_15m_price,p15.observed_epoch after_15m_epoch
 from base t
 left join lateral(
  select price,observed_epoch,resolution_seconds
  from pi.rn1_historical_price_points h
  where h.token_id=t.token_id
   and h.observed_epoch between t.ts-180 and t.ts
   and h.observed_epoch+h.resolution_seconds<=t.ts
   and h.observed_epoch+h.resolution_seconds>=t.ts-120
  order by h.observed_epoch desc limit 1
 ) p0 on true
 left join lateral(
  select price
  from pi.rn1_historical_price_points h
  where h.token_id=t.token_id
   and h.observed_epoch between t.ts-510 and t.ts-300
   and h.observed_epoch+h.resolution_seconds<=t.ts-300
   and h.observed_epoch+h.resolution_seconds>=t.ts-480
  order by h.observed_epoch desc limit 1
 ) p5 on true
 left join lateral(
  select price,observed_epoch
  from pi.rn1_historical_price_points h
  where h.token_id=t.token_id
   and h.observed_epoch between t.ts+900 and t.ts+1020
   and h.observed_epoch+h.resolution_seconds<=t.resolution_ts
  order by h.observed_epoch asc limit 1
 ) p15 on true
), inserted as(
 insert into pi.rn1_fill_price_benchmark(
  wallet,trade_key,market_key,token_id,bought_at,shares,fill_price,payout_per_share,resolved_at,
  reference_price,reference_epoch,reference_width_seconds,prior_5m_price,
  after_15m_price,after_15m_epoch
 )
 select wallet,trade_key,market_key,token_id,reported_at,shares,price,payout,resolved_at,
 reference_price,reference_epoch,reference_width_seconds,prior_5m_price,
 after_15m_price,after_15m_epoch
 from observations
 on conflict(wallet,trade_key) do update set
  reference_price=excluded.reference_price,
  reference_epoch=excluded.reference_epoch,
  reference_width_seconds=excluded.reference_width_seconds,
  prior_5m_price=excluded.prior_5m_price,
  after_15m_price=excluded.after_15m_price,
  after_15m_epoch=excluded.after_15m_epoch,
  computed_at=now()
 returning market_key,reference_price,after_15m_price
)
select count(*) as audited_fills,count(distinct market_key) as audited_markets,
 count(*) filter(where reference_price is not null) as causal_pretrade_reference,
 count(*) filter(where after_15m_price is not null) as forward_15min_reference
from inserted;
