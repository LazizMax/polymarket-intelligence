"""RN1 snapshot inventory transitions should not be falsely causal."""
from pathlib import Path
import re

ROOT=Path(__file__).resolve().parents[1]
API=(ROOT/"supabase/functions/pi-dashboard/index.ts").read_text(encoding="utf-8")
UI=(ROOT/"web/index.html").read_text(encoding="utf-8")

def test_inventory_transitions_use_verified_temporal_snapshots():
    match=re.search(r"const inventoryTransitions=await db\.unsafe\(`([\s\S]*?)`\);",API)
    assert match
    sql=match.group(1)
    assert "r.position_status='complete'" in sql
    assert "r.position_observed_at<=r.requested_at" in sql
    assert "r.position_observed_at>b.trade_at" in sql
    assert "r.position_observed_at<=b.trade_at+interval '5 minutes'" in sql
    assert "row_number() over(partition by b.fingerprint" in sql
    assert "from later where rn=1" in sql

def test_inventory_changes_are_described_not_attributed():
    assert "Évolution de l'inventaire après les achats" in UI
    assert "pas des effets attribuables à chaque achat" in UI
    assert "inv.transitions" in UI
