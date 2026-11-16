-- RN1 Maker v2: strictly bounded market-minute panel.
-- Historical observations are retrospective. Absence of an observed fill does not
-- establish absence of a resting order.
create or replace view pi.rn1_maker_historical_minute_panel_v2
with (security_invoker=true) as
with token_span as (
 select token_id,min(trade_at) first_fill_at,max(trade_at) last_fill_at,count(*) archived_fills,
 min(event_slug) event_slug
 from pi.rn1_maker_historical_fills
 where event_slug is not null
 group by token_id having count(distinct event_slug)=1 and count(*)>=3
),
prices as (
 select token_id,observed_epoch,price,
 lag(price,5) over(partition by token_id order by observed_epoch) lag5_price,
 lag(observed_epoch,5) over(partition by token_id order by observed_epoch) lag5_at
 from pi.rn1_historical_price_points
 where resolution_seconds=60 and price between 0.01 and 0.99
)
select s.event_slug,p.token_id,to_timestamp(p.observed_epoch) minute_at,p.price,
 case when p.observed_epoch-p.lag5_at between 240 and 420 then p.price-p.lag5_price end delta_5m,
 (select count(*) from pi.rn1_maker_historical_fills f
  where f.token_id=p.token_id and f.role='maker'
    and f.trade_at>to_timestamp(p.observed_epoch)
    and f.trade_at<=to_timestamp(p.observed_epoch+60)) maker_fills_next_60s,
 (select count(*) from pi.rn1_maker_historical_fills f
  where f.token_id=p.token_id and f.role='taker'
    and f.trade_at>to_timestamp(p.observed_epoch)
    and f.trade_at<=to_timestamp(p.observed_epoch+60)) taker_fills_next_60s,
 s.archived_fills,
 s.first_fill_at,s.last_fill_at
from prices p join token_span s using(token_id)
where to_timestamp(p.observed_epoch)>=s.first_fill_at
 and to_timestamp(p.observed_epoch+60)<=s.last_fill_at;
revoke all on pi.rn1_maker_historical_minute_panel_v2 from anon,authenticated;
