"""Performance analytics for Polymarket Intelligence.

Two separate curves:
- Observed cumulative PnL: drawdown in USDC only, never a capital ROI.
- Verified daily portfolio equity + external flows: *indicative* flow-adjusted return
  under an end-of-day cash-flow convention. Not a certified intraday time-weighted ROI.

This module deliberately refuses to fabricate a capital ROI from trades, turnover,
closed positions, or wallet PnL snapshots.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from math import isfinite
from statistics import mean


def _date(v):
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    return date.fromisoformat(str(v))


def _number(v, label):
    if isinstance(v, bool) or v is None:
        raise ValueError(f"{label} is missing")
    try:
        n = float(v)
    except (ValueError, TypeError, OverflowError) as exc:
        raise ValueError(f"{label} is not numeric") from exc
    if not isfinite(n):
        raise ValueError(f"{label} is not finite")
    return n


def _points(rows, value_key):
    points = sorted(
        [(_date(row["date"]), _number(row[value_key], value_key), row) for row in rows],
        key=lambda item: item[0],
    )
    if len(points) != len({x[0] for x in points}):
        raise ValueError("Duplicate dates are not allowed")
    gaps = sum((points[i][0] - points[i - 1][0]).days - 1 for i in range(1, len(points)))
    return points, gaps


def _trend_r2(dates, values):
    """Fit values to elapsed calendar days; R² alone does not imply profitability."""
    if len(values) < 3:
        return None
    x = [(d - dates[0]).days for d in dates]
    mx, my = mean(x), mean(values)
    ssx = sum((a - mx) ** 2 for a in x)
    ssy = sum((b - my) ** 2 for b in values)
    if not ssx or not ssy:
        return None
    slope = sum((a - mx) * (b - my) for a, b in zip(x, values)) / ssx
    residual = sum((y - my - slope * (a - mx)) ** 2 for a, y in zip(x, values))
    return max(0.0, min(1.0, 1.0 - residual / ssy))


def _underwater(values):
    peak = values[0]
    max_loss = 0.0
    worst_from = 0
    worst_to = 0
    top_index = 0
    for i, v in enumerate(values):
        if v >= peak:
            peak, top_index = v, i
        elif peak - v > max_loss:
            max_loss = peak - v
            worst_from, worst_to = top_index, i
    return max_loss, worst_from, worst_to


def pnl_curve_stats(rows):
    """Observed drawdown on cumulative USD PnL snapshots, not portfolio drawdown.

    Missing days make max drawdown an *observed lower bound* on true drawdown.
    Only the delta between first/last points is measured; no zero-origin assumption.
    """
    points, missing = _points(rows, "cumulative_pnl_usdc")
    if len(points) < 2:
        return {
            "status": "INSUFFICIENT_POINTS",
            "observations": len(points),
            "max_observed_drawdown_usdc": None,
            "pnl_over_observed_drawdown": None,
            "roi_pct": None,
        }
    dates = [p[0] for p in points]
    values = [p[1] for p in points]
    loss, from_i, to_i = _underwater(values)
    pnl = values[-1] - values[0]
    deltas = [values[i] - values[i - 1] for i in range(1, len(values))]
    return {
        "status": "GAPPED_OBSERVATIONS" if missing else "OBSERVED_PNL_ONLY",
        "observations": len(points),
        "first_day": dates[0].isoformat(),
        "last_day": dates[-1].isoformat(),
        "missing_days": missing,
        "pnl_change_usdc": round(pnl, 4),
        "max_observed_drawdown_usdc": round(loss, 4),
        "drawdown_peak_day": dates[from_i].isoformat(),
        "drawdown_trough_day": dates[to_i].isoformat(),
        "pnl_over_observed_drawdown": round(pnl / loss, 4) if loss > 0 else None,
        "positive_daily_change_pct": round(
            100.0 * sum(x > 0 for x in deltas) / len(deltas), 2
        ),
        "pnl_linearity_r2": round(_trend_r2(dates, values), 6)
        if _trend_r2(dates, values) is not None else None,
        "roi_pct": None,
    }


def flow_adjusted_equity_stats(rows):
    """Conservative daily equity curve with a disclosed end-of-day-flow assumption.

    Expects complete, *verified* daily snapshots:
    equity_usdc = all cash plus marked positions at the end of each day.
    external_flow_usdc = net deposits minus withdrawals that day.
    The result is NOT an audited TWR when cash-flow times within the day are unknown.
    """
    points, gaps = _points(rows, "equity_usdc")
    result = {
        "status": "UNVERIFIED_EQUITY",
        "observations": len(points),
        "capital_roi_estimate_pct": None,
        "max_drawdown_pct": None,
        "return_over_max_drawdown": None,
        "equity_linearity_r2": None,
        "assumption": "External cash flows are placed at end of day; not intraday TWR.",
    }
    if len(points) < 2:
        result["status"] = "INSUFFICIENT_POINTS"
        return result
    if gaps:
        result["status"] = "MISSING_DAYS"
        return result
    if any(p[2].get("verified") is not True for p in points):
        return result
    balances = [p[1] for p in points]
    if any(v <= 0 for v in balances):
        result["status"] = "INVALID_EQUITY"
        return result
    index = [1.0]
    for i in range(1, len(points)):
        try:
            external = _number(points[i][2]["external_flow_usdc"], "external_flow_usdc")
        except (ValueError, KeyError):
            result["status"] = "MISSING_CASH_FLOWS"
            return result
        adjustment = (balances[i] - external) / balances[i - 1]
        if adjustment <= 0:
            result["status"] = "INCOMPATIBLE_CASH_FLOW"
            return result
        index.append(index[-1] * adjustment)
    peak = index[0]
    max_dd = 0.0
    for i in index:
        peak = max(peak, i)
        max_dd = max(max_dd, (peak - i) / peak)
    roi = (index[-1] - 1.0) * 100
    dd = max_dd * 100
    trend = _trend_r2([p[0] for p in points], index)
    result.update({
        "status": "INDICATIVE_END_OF_DAY_FLOW_RETURN",
        "capital_roi_estimate_pct": round(roi, 4),
        "max_drawdown_pct": round(dd, 4),
        "return_over_max_drawdown": round(roi / dd, 4) if dd > 0 else None,
        "equity_linearity_r2": round(trend, 6) if trend is not None else None,
    })
    return result
