-- Prevent deceptive high recovery factors driven by a single outlier day.
alter table pi.wallet_metrics_daily
 add column if not exists active_pnl_change_days integer,
 add column if not exists positive_active_change_pct numeric(18,6),
 add column if not exists largest_positive_day_share_pct numeric(18,6);
