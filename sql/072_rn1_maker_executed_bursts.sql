-- Maker/Taker fill clustering is a candidate execution burst, NOT a verified parent order.
-- Timestamps in archive are second-granularity. An identical-price burst can
-- combine different orders, while one parent order can execute across prices/times.
create or replace view pi.rn1_maker_historical_bursts
with (security_invoker=true) as
with ordered as (
 select fingerprint,event_slug,market_key,token_id,role,side,outcome_index,price,shares,trade_at,
 lag(trade_at) over(partition by market_key,token_id,role,side,price order by trade_at,fingerprint) preceding_at
 from pi.rn1_maker_historical_fills
), marked as (
 select *,case when preceding_at is null or trade_at-preceding_at>interval '1 second' then 1 else 0 end burst_start
 from ordered
), numbered as (
 select *,sum(burst_start) over(partition by market_key,token_id,role,side,price order by trade_at,fingerprint rows unbounded preceding) burst_number
 from marked
)
select min(event_slug) event_slug,market_key,token_id,role,side,outcome_index,price,burst_number,
 min(trade_at) first_at,max(trade_at) last_at,count(*)::integer fill_count,
 sum(shares) shares,sum(shares*price) notional
from numbered
group by market_key,token_id,role,side,outcome_index,price,burst_number;
revoke all on pi.rn1_maker_historical_bursts from anon,authenticated;
