"""Regression tests: no capital ROI from PnL snapshots or incomplete data."""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "cloud"))
from performance_analytics import flow_adjusted_equity_stats, pnl_curve_stats


def pnl(day, value):
    return {"date": day, "cumulative_pnl_usdc": value}


def equity(day, value, flow=0, verified=True):
    return {"date": day, "equity_usdc": value,
            "external_flow_usdc": flow, "verified": verified}


class PerformanceAnalyticsTests(unittest.TestCase):
    def test_pnl_drawdown_in_usdc_not_roi(self):
        data = [pnl("2026-11-01", 0), pnl("2026-11-02", 20),
                pnl("2026-11-03", 10), pnl("2026-11-04", 30)]
        result = pnl_curve_stats(data)
        self.assertEqual(result["max_observed_drawdown_usdc"], 10)
        self.assertEqual(result["pnl_change_usdc"], 30)
        self.assertEqual(result["pnl_over_observed_drawdown"], 3)
        self.assertIsNone(result["roi_pct"])
        self.assertEqual(result["status"], "OBSERVED_PNL_ONLY")

    def test_nonzero_first_pnl_is_not_zero_origin(self):
        result = pnl_curve_stats([pnl("2026-11-01", 2000), pnl("2026-11-02", 2050)])
        self.assertEqual(result["pnl_change_usdc"], 50)
        self.assertEqual(result["max_observed_drawdown_usdc"], 0)
        self.assertIsNone(result["pnl_over_observed_drawdown"])

    def test_missing_days_not_hidden(self):
        result = pnl_curve_stats([pnl("2026-11-01", 30), pnl("2026-11-04", 10)])
        self.assertEqual(result["missing_days"], 2)
        self.assertEqual(result["status"], "GAPPED_OBSERVATIONS")
        self.assertEqual(result["max_observed_drawdown_usdc"], 20)

    def test_equity_must_be_verified(self):
        r = flow_adjusted_equity_stats([
            equity("2026-11-01", 1000),
            equity("2026-11-02", 1020, verified=False)])
        self.assertEqual(r["status"], "UNVERIFIED_EQUITY")
        self.assertIsNone(r["capital_roi_estimate_pct"])

    def test_equity_missing_day_refuses_return(self):
        r = flow_adjusted_equity_stats([
            equity("2026-11-01", 1000), equity("2026-11-03", 1200)])
        self.assertEqual(r["status"], "MISSING_DAYS")
        self.assertIsNone(r["max_drawdown_pct"])

    def test_equity_adjusts_for_deposit(self):
        r = flow_adjusted_equity_stats([
            equity("2026-11-01", 1000),
            equity("2026-11-02", 1600, flow=500),
            equity("2026-11-03", 1760)])
        self.assertEqual(r["status"], "INDICATIVE_END_OF_DAY_FLOW_RETURN")
        self.assertEqual(r["capital_roi_estimate_pct"], 21)
        self.assertEqual(r["max_drawdown_pct"], 0)
        self.assertIsNone(r["return_over_max_drawdown"])

    def test_equity_drawdown_and_return_over_drawdown(self):
        r = flow_adjusted_equity_stats([
            equity("2026-11-01", 1000), equity("2026-11-02", 1100),
            equity("2026-11-03", 990), equity("2026-11-04", 1089)])
        self.assertAlmostEqual(r["capital_roi_estimate_pct"], 8.9)
        self.assertEqual(r["max_drawdown_pct"], 10.0)
        self.assertAlmostEqual(r["return_over_max_drawdown"], 0.89)

    def test_duplicate_day_refused(self):
        with self.assertRaises(ValueError):
            pnl_curve_stats([pnl("2026-11-01", 0), pnl("2026-11-01", 20)])

    def test_infinite_pnl_refused(self):
        with self.assertRaises(ValueError):
            pnl_curve_stats([pnl("2026-11-01", 0), pnl("2026-11-02", float("inf"))])

    def test_negative_flow_adjusted_equity_refused(self):
        r = flow_adjusted_equity_stats([
            equity("2026-11-01", 100), equity("2026-11-02", 200, flow=250)])
        self.assertEqual(r["status"], "INCOMPATIBLE_CASH_FLOW")
        self.assertIsNone(r["capital_roi_estimate_pct"])


if __name__ == "__main__":
    unittest.main()
