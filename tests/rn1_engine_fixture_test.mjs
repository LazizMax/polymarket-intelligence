import assert from "node:assert/strict";
import {rn1EngineForensics} from "../supabase/functions/pi-dashboard/rn1-engine.ts";

// Synthetic controls exercise the real TypeScript inference, cross-validation,
// two-outcome matching and event bootstrap; they are NOT RN1 data.
const rows = [];
for (let e = 0; e < 30; e++) {
  for (let k = 0; k < 12; k++) {
    const share0 = 20 + (k % 2) * 50;
    const share1 = 20 + ((k + 1) % 2) * 50;
    const fill = k % 3 === 0 ? (share0 < share1 ? 0 : 1) : -1;
    const time = 1000000 + e * 3600 + k * 60;
    for (let side = 0; side < 2; side++) {
      rows.push({
        event_slug: "nba-synthetic-" + e,
        market_key: "synthetic-market-" + e,
        token_id: "token-" + e + "-" + side,
        origin: e % 2 ? "rn1_recent" : "sports_control",
        observed_epoch: time,
        mid: side === 0 ? .45 : .55,
        spread: .02,
        bid_size: 300 + 10 * k,
        ask_size: 500 + 7 * k,
        own_shares: side === 0 ? share0 : share1,
        other_shares: side === 0 ? share1 : share0,
        market_cost: 70 + k,
        book_age_seconds: 12,
        quote_momentum: 0,
        observed_next_fill: fill === side ? 1 : 0
      });
    }
  }
}
const data = await rn1EngineForensics({
  unsafe: async (sql) => {
    assert(sql.includes("own.returned AND other.returned"));
    assert(sql.includes("f.trade_at>t.received_at"));
    return rows;
  }
});
assert.equal(data.status, "research_candidate");
assert.equal(data.overview.eligible_windows, 720);
assert.equal(data.overview.events, 30);
assert.equal(data.overview.observed_fill_windows, 120);
assert.equal(data.folds.length, 5);
assert.equal(data.folds.reduce((s,f)=>s+f.test_windows,0),720);
assert.equal(data.mirror_test.paired_windows,360);
assert.equal(data.mirror_test.exactly_one_side_filled,120);
assert.equal(data.mirror_test.one_side_and_imbalanced,120);
assert.equal(data.mirror_test.filled_underweight,120);
assert.equal(data.mirror_test.filled_overweight,0);
assert(data.mirror_test.event_bootstrap_ci.low>=0.999);
for(const model of data.scores){
 assert(Number.isFinite(model.log_loss));
 assert(Number.isFinite(model.brier));
 assert(model.average_precision>=0 && model.average_precision<=1);
}
assert.equal(data.hypothesis.external_oracle, "unidentifiable_no_time_stamped_external_odds");
console.log("RN1 synthetic engine: 5 event folds, 4 models, paired-outcome test OK");
