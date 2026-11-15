"""Regression guard: all RN1 candidate quote rules share an identical fill cohort.

The SQL query is executed against live read-only Supabase separately during audit.
This source-level test prevents accidental reintroduction of per-model fill filtering.
"""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
API = (ROOT / "supabase/functions/pi-dashboard/index.ts").read_text(encoding="utf-8")


def test_inventory_model_uses_common_fill_cohort():
    match = re.search(r"const inventoryModels=await db\.unsafe\(`([\s\S]*?)`\);", API)
    assert match, "RN1 inventory model SQL must exist"
    sql = match.group(1)
    assert "), eligible as(" in sql
    assert "from eligible" in sql
    assert "from candidates\n  cross join lateral" not in sql
    assert "where model_price>=tick" not in sql
    assert "least(model_best_bid,model_one_tick_below,model_two_ticks_below" in sql
    assert "greatest(model_best_bid,model_one_tick_below,model_two_ticks_below" in sql
    assert "count(distinct event_slug)::int events" in sql


def test_holdout_decision_is_gated_on_independent_events():
    ui = (ROOT / "web/index.html").read_text(encoding="utf-8")
    assert "Number(check.fills)>=100&&Number(check.events)>=10" in ui
    assert "Meilleure règle choisie sur la période d'entraînement" in ui
