"""Structural invariants for public v2 position snapshots.

A passing result validates API arithmetic only; it does not certify net profit,
execution costs, missing positions, or a lifetime cash-flow ledger.
"""
from __future__ import annotations
import math


def finite(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        v = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return v if math.isfinite(v) else None


def approximately(a, b):
    """Allow small USD/share rounding, not a multi-dollar accounting mismatch."""
    return abs(a-b) <= max(.025, 1e-4*max(abs(a), abs(b)))


def check_position(raw, *, held=False):
    """Return stable issue codes for checkable contradictions; missing data is separate."""
    if not isinstance(raw, dict):
        return ['not_an_object']
    issues=[]
    def get(name):return finite(raw.get(name))
    cost, entry, fees=get('total_cost_usdc'),get('entry_cost_usdc'),get('entry_fees_usdc')
    if cost is not None and entry is not None and fees is not None and not approximately(cost,entry+fees):
        issues.append('cost_components_mismatch')
    realized, unrealized, total=get('realized_pnl'),get('unrealized_pnl'),get('total_pnl')
    if total is not None and realized is not None and unrealized is not None and not approximately(total,realized+unrealized):
        issues.append('pnl_components_mismatch')
    current_size, bought=get('current_size'),get('total_size')
    if current_size is not None and current_size < -1e-5:
        issues.append('negative_current_shares')
    if bought is not None and bought < -1e-5:
        issues.append('negative_total_shares')
    if current_size is not None and bought is not None and current_size > bought + max(1e-5, bought*1e-6):
        issues.append('current_shares_exceed_total_bought')
    current_value, current_price=get('current_value'),get('current_price')
    if current_size is not None and current_price is not None and current_value is not None:
        if not approximately(current_value,current_size*current_price):
            issues.append('current_value_mismatch')
    return issues
