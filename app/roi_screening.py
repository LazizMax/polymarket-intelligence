"""Exploratory event-cluster screening of CLOSED-position cost-weighted ROI.

No causal claim, no multiple-selection correction, no copy-trading profitability.
Reject missing costs rather than cherry-picking priced outcomes. A market may
share information with others, so distinct event identifiers are not always
statistically independent.
"""
from __future__ import annotations
import hashlib
import math
import random

MIN_EVENTS = 30


def lower_roi_by_event(events, *, wallet='', draws=750, percentile=0.05):
    """Return a bootstrap lower bound on sum(event PnL)/sum(event cost).

    Each *event* is resampled as a unit; no event is weighted by trade count.
    The within-resample ROI is nevertheless capital-weighted, never the mean
    of per-event percentage returns. Deterministic seed for repeatable UI.
    """
    if draws < 100 or not 0 < percentile < .5:
        raise ValueError('Invalid bootstrap settings')
    groups = []
    distinct = set()
    for e in events:
        key = str(e.get('event_key') or e.get('event_id') or '').strip()
        cost = e.get('basis_usdc')
        pnl = e.get('pnl_usdc')
        if not key or key in distinct or not e.get('basis_coverage_complete'):
            return None
        distinct.add(key)
        try:
            cost = float(cost)
            pnl = float(pnl)
        except (TypeError, ValueError):
            return None
        if not math.isfinite(cost) or cost <= 0 or not math.isfinite(pnl):
            return None
        groups.append((pnl, cost))
    if len(groups) < MIN_EVENTS:
        return None
    n = len(groups)
    full_pnl = sum(p for p, _ in groups)
    full_cost = sum(c for _, c in groups)
    seed = int.from_bytes(hashlib.sha256(str(wallet).encode('utf-8')).digest()[:8], 'big')
    rng = random.Random(seed)
    outcomes = []
    for _ in range(draws):
        pnl_sum = cost_sum = 0.
        for _ in range(n):
            pnl, cost = groups[rng.randrange(n)]
            pnl_sum += pnl
            cost_sum += cost
        outcomes.append(100. * pnl_sum / cost_sum)
    outcomes.sort()
    pos = max(0, min(draws - 1, math.ceil(percentile * draws) - 1))
    gains = [max(0., pnl) for pnl, _ in groups]
    concentration = 100. * max(gains) / sum(gains) if sum(gains) > 0 else None
    return {
        'roi_closed_cost_weighted_pct':round(100. * full_pnl / full_cost, 3),
        'roi_event_bootstrap_low_5pct':round(outcomes[pos], 3),
        'events':n,
        'cost_usdc':round(full_cost, 2),
        'pnl_usdc':round(full_pnl, 2),
        'largest_win_share_pct':round(concentration, 2) if concentration is not None else None,
        'draws':draws,
        'status':'EXPLORATORY_NOT_OUT_OF_SAMPLE',
    }
