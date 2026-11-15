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
