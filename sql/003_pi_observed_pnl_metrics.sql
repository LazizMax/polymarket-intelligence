-- Observed PnL dynamics are USD metrics, not portfolio ROI.
alter table pi.wallet_metrics_daily
 add column if not exists pnl_observed_change_usdc numeric(28,10),
 add column if not exists pnl_recovery_factor numeric(18,6),
 add column if not exists pnl_slope_usdc_per_day numeric(28,10),
 add column if not exists missing_pnl_days integer,
 add column if not exists pnl_observed_from date,
 add column if not exists pnl_observed_through date;
