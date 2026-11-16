"""RN1 black-box M0 baseline must use predecision inputs and event-held-out labels."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API = (ROOT / "supabase/functions/pi-dashboard/index.ts").read_text(encoding="utf-8")
ENGINE = (ROOT / "supabase/functions/pi-dashboard/rn1-engine.ts").read_text(encoding="utf-8")
UI = (ROOT / "web/index.html").read_text(encoding="utf-8")


def test_new_read_only_authenticated_route_and_ui():
    assert 'import {rn1EngineForensics} from "./rn1-engine.ts"' in API
    assert 'if(body?.action==="rn1_engine_forensics")return send(await rn1EngineForensics(db));' in API
    assert "if(!await allowed(req))" in API
    assert 'data-tab="engine"' in UI
    assert 'tab==="engine")await renderRN1Engine()' in UI
    assert 'api("rn1_engine_forensics")' in UI


def test_strictly_predecision_features_and_no_fill_scope():
    assert "position_status='complete'" in ENGINE
    assert "position_observed_at<=received_at" in ENGINE
    assert "own.returned AND other.returned" in ENGINE
    assert "q.book_at<=q.received_at" in ENGINE
    assert "f.trade_at>t.received_at" in ENGINE
    assert "f.trade_at<=t.received_at+interval '60 seconds'" in ENGINE
    assert "lag(mid) over(partition by market_key,token_id order by received_at,run_id)" in ENGINE
    assert "M1/M2" not in ENGINE or 'unidentifiable_no_time_stamped_external_odds' in ENGINE
    assert "Maker inférée" in UI or "Maker inférés" in UI


def test_event_fold_and_held_out_train_contract():
    assert "hashEvent(r.event)%5" in ENGINE
    assert "(folds[i]===fold?test:train).push(i)" in ENGINE
    assert "fit(rows,train,m.columns)" in ENGINE
    assert "for(const i of test)predictions[m.id][i]" in ENGINE
    assert "event_bootstrap_ci" in ENGINE
    assert "n>=10" in ENGINE


def test_paired_outcome_and_falsification():
    assert 'const key=r.market+"|"+r.time;' in ENGINE
    assert "if(group.length!==2||group[0].token===group[1].token)continue;" in ENGINE
    assert "Math.abs(a.own-b.own)/(a.own+b.own+1)" in ENGINE
    assert "const correct=(a.y===1&&a.own<b.own)||(b.y===1&&b.own<a.own);" in ENGINE
    assert "mirror_test" in ENGINE
    assert "Côté sous-détenu" in UI


def test_external_odds_unavailable_is_not_mislabeled_negative_evidence():
    assert 'external_oracle:"unidentifiable_no_time_stamped_external_odds"' in ENGINE
    assert "pas de backtest d'exécution ni de PnL" in ENGINE
    assert "NON IDENTIFIABLE" in UI
    assert "aucun fill rapproché observé" in ENGINE
