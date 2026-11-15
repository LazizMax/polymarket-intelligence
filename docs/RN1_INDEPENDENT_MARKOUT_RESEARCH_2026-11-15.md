# RN1 — Historical independent price markouts, stratified audit

Date: 2026-11-15. State: **automated analysis in progress**. The reported numbers below are a snapshot, NOT a completed historical conclusion.

## What was independently verified

A read-only private Edge diagnostic opened archived RN1 pages 700 (late August), 400 (late September) and 100 (early November). For each, the 4 most frequently executed tokens yielded **HTTP 200** and populated `GET https://clob.polymarket.com/prices-history?market=<token-id>&startTs=...&endTs=...&fidelity=1`. The sample demonstrates availability across three dates, NOT universal coverage.

The historical CLOB time series is **not** an archived order book and does not recover the exact best bid/ask, fill priority or order cancellation. Its observations can also be influenced by RN1's own market impact. Do not call this risk-free arbitrage or a true independent counterfactual.

## Live private stratified worker

- Source: `supabase/functions/pi-rn1-independent-price/index.ts`
- Function: `pi-rn1-independent-price` (private Vault-based scheduler token, SHA-256 validated)
- Scheduled job: `pi-rn1-independent-prices-1min`, bounded 3 pages per call
- Database: private `pi.rn1_independent_price_jobs`, `pi.rn1_independent_price_pages`; RLS ON, anonymous/authenticated table SELECT denied
- Cohort: original **756 pages**, chronologically replayed oldest to newest, source SHA verified before processing; newer archival pages collected after cohort freeze are out of cohort
- Source role check: query the same source-time window with `taker_only=true`, use exact-fill signature **multiset** and reconcile with per-page independent audit. Ambiguous mixed duplicates remain `unknown`
- Deterministic token sampling: for each archive page choose the **8 lowest FNV32 hashes of (page_no, token_id)** among all token IDs on that page. The rule is independent of executed prices and future returns; all associated BUY fills of selected tokens are considered. Important: **uniform among tokens, not among fills**.
- Inventaire d'exécutions: reconstruct purchases/sales for both sides before each fill; classify own side underweight / overweight / neutral. Not true wallet account balances because of merges/redeems/transfers.
- Future observations: public `prices-history` on the *same token*, earliest timestamp at or after fill + 1, 5, 15, 30 or 60 minutes, with bounded grace (150 / 180 / 180 / 240 / 300 seconds); no look-ahead in feature assignment.
- Detailed state/checkpoints in private gzip Storage, SQL only compact progress, page summaries and sample coverage. Prior checkpoints removed only after replacement is transactionally committed.

## Correcting the variable probability of token selection

Let `N_i` = number of distinct eligible tokens in archive page `i`, `n_i` = min(8,`N_i`). Each token's inclusion probability in that page is `n_i/N_i` under a uniform random hash approximation.

For any observed selected fills, estimate the **quantity-weighted** future price change using
```text
 sum_over_pages( N_i/n_i × sum_selected(shares × (future_public_price - fill_price)) )
 -------------------------------------------------------------------------------
 sum_over_pages( N_i/n_i × sum_selected(shares) )
```

This corrects unequal *token-level* inclusion probabilities across pages, but NOT future price missingness, unequal event dependence, incomplete archival history, the conditioning on filled orders, fee/slippage effects, or the ability to execute that price.

On the first sampled pages the source contained **67 to 336 tokens per page**, despite selecting 8. Raw quantities across pages therefore should not be interpreted as the population-weighted rate. The number of source tokens is recorded for each new page; early pages have been backfilled from SHA-verified private archives without fetching prices again.

## Early observations, NOT final evidence

At the 37-page checkpoint (all first week, late Aug): **1,758 Maker fills with public future prices near 15m**. Raw quantity-weighted change approximately **+$0.00195/share**; adjusted for token sampling probability **+$0.01407/share**. Underweight side adjusted **+$0.01571/share**, overweight adjusted **+$0.01651/share**. The earlier 19-page preliminary results were different; avoid drawing strategy conclusions before the full period and independent event checks.

These measurements are not net PnL, realized profits, observed bid/ask advantages, nor predictions for unfilled limit orders. Each fill contributes one or more correlated observations and event-level uncertainty is still unmeasured.

## What remains before declaring an edge

1. Finish current **756-page** fixed cohort, monitor missing history and disabled status under shared DB budget.
2. Recompute on the complete source after it reaches `source_exhausted`, if additional older pages were appended.
3. Hold out late calendar periods and independent sporting events; use event-clustered uncertainty and exclude stale/absent future prices with explicit coverage.
4. Compare the public historical price moves with self-wallet future execution price proxies: divergences measure proxy bias, not RN1's expected alpha by themselves.
5. Combine with market outcome/REDEEM/MERGE and fees, and estimate realistic maker order fills from separately collected LIVE orderbooks; no historical unfilled order set exists.

Reproducible SQL: [`sql/rn1_independent_price_markouts.sql`](../sql/rn1_independent_price_markouts.sql).

## Addendum: event-clustered statistical uncertainty (live v4)

The independent-price worker now records in the **private, gzip-compressed checkpoint**, rather than a large SQL table, a compact accumulation of fill-weighted markout numerator and exposure denominator for each distinct sporting `event_slug`, for each of five horizons and three Maker strata (all/underweight/overweight). When no event slug is present, a market identifier is used as a fallback and marked conceptually as a weaker clustering key.

For each event cluster `j` let `Y_j = Σ_i w_i × shares_i × (future_public_price_i − fill_price_i)` and `X_j = Σ_i w_i × shares_i`, with page-token inclusion weight `w_i=N_page/n_page`. The estimator is `mu = Σ_jY_j/Σ_jX_j`; an event-clustered approximate standard error is

```text
 se(mu) = sqrt( G/(G-1) × Σ_j (Y_j - mu×X_j)^2 / (Σ_j X_j)^2 )
 95%-approx interval = mu ± 1.96 × se(mu)
```

This is a **cluster-robust diagnostic only**. It does not establish a valid causal edge if fills are selected by liquidity/price availability, if different events share a common risk driver, or if RN1's trades move the quoted time-series prices. At minimum the dashboard requires 30 independent event clusters to display the approximate range. Even a range excluding zero is not evidence of *net tradable alpha*.

**Critical coverage caveat:** This event accumulation was introduced in the middle of the running replay (starting with source page **677**); it is not backfilled for the ~79 pages processed before code v4. Thus the event-level `fills` and `events` counts are purposely smaller than the full sampled `Maker` totals. The snapshot remains live and accumulates new processed pages without restarting completed ones. Never mix it with total-sample event counts or present it as a full-period confidence interval.

First verified operation: page 677 succeeded with 7 sporting-event clusters and 20 eligible Maker fills, estimated mean +$0.04016 per share and indicative interval +$0.00948 to +$0.07083. A few pages later, event count 25 / 89 fills, interval −$0.02536 to +$0.05234 **crossing zero**. This demonstrates how unstable very early event-cluster estimates are; it is **not** a stable or significant edge.

For any final investment/copy decision, confirm multiple disjoint time periods, sufficient separate events and unaffected-outcome price references, known probability of order fill, fees and capital exposure. Neither statistical clustering nor correction for token sampling addresses those execution constraints.

## Addendum: within-the-same-event Maker inventory comparison (v5/v6)

New `eventPairedDifferences` compares purchases classified **underweight** (less accumulated YES/NO side) with purchases classified **overweight** (already dominant side) **inside the same sporting event**. Both groups must have an independently observed public price at the same requested post-fill horizon.

Each eligible event receives exactly one value:

```text
D_event = [sum(token-IPW * shares * price_move) / sum(token-IPW * shares)]_underweight
        - [sum(token-IPW * shares * price_move) / sum(token-IPW * shares)]_overweight
```

Across events, each sporting event has equal weight; an approximate 95% interval uses the sample standard deviation of event differences divided by `sqrt(number_of_events)`, and is only shown on the dashboard with at least 30 paired events. This is a *matched-event association*, NOT a randomized intervention or proof of a portfolio-management causal mechanism. Different buy times within the same event, unfilled passive orders, unavailable future prices and outcomes can still confound it.

**Important source coverage:** event-level accumulation started with page 677 of the immutable cohort. A refresh operation reads the existing private gzip checkpoint and writes only the compact `event_paired_differences` summary field, **without replaying earlier pages or updating the cursor**. This method was verified successfully with the worker in `paused_quota` mode.

At 107 independent-price sample pages / 33 paired events:

| Horizon | Paired events | Underweight fills | Overweight fills | Difference (cents per share) | Approx. 95% interval (cents) |
|---|---:|---:|---:|---:|---:|
| 1m | 33 | 154 | 191 | −0.875 | [−2.363, +0.613] |
| 5m | 33 | 154 | 191 | +0.771 | [−2.463, +4.004] |
| 15m | 33 | 154 | 191 | +0.793 | [−4.076, +5.661] |
| 30m | 33 | 153 | 179 | +1.240 | [−4.350, +6.829] |
| 60m | 25 | 85 | 135 | +5.021 | [−6.092, +16.134] |

Every interval **includes zero**, and the 60m interval is not actionable due to fewer than 30 paired events. There is no statistically demonstrated difference in independent public market price moves between the underweight and overweight Maker cohorts in this early matched-event analysis.

### Operational incident at 107 pages

The shared database passed **298 MB**; both `rn1_full_chronology_v1` and `rn1_independent_price_v1` workers correctly transitioned to `paused_quota` at 211,000 chronological fills and 107,000 scanned independent-price fills respectively. Three further safe concurrent index rebuilds reduced the footprint to approximately **295.7 MB**, but not to a sustainable headroom for both workers. **Do not simply raise caps or indefinitely reindex hot tables.** Private archive ingestion and the CLOB quote collector were still independently active at the last confirmed check. A durable capacity change, likely isolating Polymarket analytical storage from the shared project, is still required; existing data and checkpoints are preserved.

## Addendum: weekly fragility, within-event role control and pairing mechanism (dedicated project)

**Deployment:** live Supabase dedicated project `qamdvfakwclkuswrdckp`, with automatic archived source, chronological role-verified replay and independent public CLOB-price sample. Existing old-project snapshot preserved for rollback; no old pages rescanned.

At an intermediate dated snapshot (168 independent sampled pages, sourced from **168,000** archived executions; cohort pages from 756 backward), the token-inclusion / filled-quantity weighted **15-minute historical public price changes per purchased share** were:

| Archived week starting | Maker sampled buys with future quote | Maker 15m (cents/share) | Taker sampled buys | Taker 15m (cents/share) |
|---|---:|---:|---:|---:|
| 2026-08-24 | 1,944 | −0.193 | 200 | +6.119 |
| 2026-08-31 | 2,609 | +0.402 | 245 | +3.472 |
| 2026-09-07 | 2,957 | −3.838 | 344 | −6.741 |

**Leave-one-week-out check (as of 152 pages):** remove 2026-08-24: −1.032 cents/share; remove 2026-08-31: −1.926 cents/share; remove 2026-09-07: **+0.191 cents/share**. The sign changes when the most negative week is removed. The 15m Maker aggregate is not robust to historical window selection. These three weeks are not a formal out-of-sample test, and the replay remains incomplete.

The dashboard now displays weekly Maker/Taker independent-price movements and three leave-one-week-out values, recalculated *automatically* as the price-history worker extends its sample, with a warning if the mean's sign flips. The persistent event-level data are accumulated in the private checkpoint only from chronological archive **page 677 onward**, so event-cluster confidence intervals may use fewer weeks than the weekly IPW aggregates. Do NOT combine their uncertainty and exposure as if they were one homogeneous cohort.

**New event-matched role analysis:** each sporting event with observable Maker and Taker buys contributes a single quantity/IPW-adjusted Maker-minus-Taker price-change difference. At 168 sampled pages and **135 matched events**, 15-minute difference approximately **−1.875 cents/share**; approximate 95% interval **[−4.936, +1.186] cents/share**. Interval includes zero. Maker/Taker are endogenous trade-execution cohorts; different times, selection of fills, underlying sports outcomes and prices can confound this even *within the same event*. This cannot identify the causal benefit of a passive limit order or maker rebate.

**Complementary inventory/paired-position evidence:** at around 295,000 chronological fills, about **41.09%** of classifiable Maker buys *reduced* the binary YES/NO share imbalance and the remainder predominantly increased it. Thus a universal “always rebalance” decision rule is **contradicted by observed executed fills**. The chronology's gross paired-cost proxy for Maker-created incremental paired shares was approximately **+0.9642 cents per newly paired share**; for Taker approximately **−0.2680 cents**. The proxy is computed as `newPairs * (1 - buy_price - reconstructed_opposing_side_average_cost)`; the counterfactual is a binary pair held/converted at total unit payoff, not an actual confirmed redemption. It omits execution fees, maker rebates, position transfers, realized sales and final inventory reconciliation; repeated inventory recycling and asymmetric fill selection may affect attribution. Neither proxy equals total strategy ROI.

The working hypotheses remain **passive two-sided accumulation with selective creation of complementary cheap binary pairs**, possibly alongside directional exposure; versus alternatives such as market-making inventory recycling and sports-event momentum. These are *candidate explanations only*. They require a fully time-aligned real-book/quote dataset and actual settled cash flows, and must be tested on independent dates/markets before considering execution.

The new role-matched event contrast is derived incrementally from the same private event aggregation already used for Maker inventory pairing. It does not require a new SQL fill table, extra archive reads, or recomputing previously finished source pages.

**CI status:** the corrected RN1 smoke workflow was run on GitHub main, and the dashboard Pages deploy succeeded. The analysis UI explicitly distinguishes independent public CLOB markouts, RN1's own future trade prices, matched-event associations and unrealized pair-cost proxies.
