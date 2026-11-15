# RN1 — Chronological executed-flow fingerprint (v1)

Question: What does RN1 **do** after fills, and how stable are these behaviours across time? This is not yet a decoder for his private model or actual limit-order placements.

## Source provenance
- The original gzip-compressed `trades_all` feed includes maker AND taker rows; `taker_only=false`, with signed opaque cursors, `start=1`.
- Freeze a cohort at the latest archived page number when `032_rn1_sequence_flow_fingerprint.sql` runs. **Do not absorb new, older pages silently**: all amounts are valid only inside the snapshot.
- Resume from the **oldest** archived page down to page #1, reversing rows within each newest-first page. The API's ordering within same-second ties is deterministic but not guaranteed to reflect exchange queue order.
- Validate wallet, schema, original JSON SHA256 and page row count **before** analysis. Pages are never altered, and the cursor only advances in the same DB transaction as changes to per-market observed state and per-page statistics.
- Use a 110-second worker lease and up to 5 pages / invocation (a scheduled check once per minute); guard the shared DB capacity and fail closed on unexpected source order or invalid rows.

## Features (observations, not policy probabilities)
- Observed trade-flow imbalance before each BUY: `buy0 - sell0` and `buy1 - sell1` *within the captured cohort*. These are **not on-chain token balances**: mergers, redemptions, transfers, prior inventory and unexecuted orders are missing.
- `underweight_buys`: the executed BUY is on the side with fewer net shares **before** the trade. `overweight_buys`: the side with more. Exclude neutral/negative/empty cases from comparisons.
- `gap_reducing_buys`: the fill reduces absolute share gap. A huge fill can **overcorrect** a gap, so buying the underweight side is not identical to reducing imbalance.
- `first_opposite_fills`: first fill on an outcome opposite the *first fill seen within this frozen cohort*, not necessarily first-ever hedge.
- Minutes since prior same-market or same-outcome fill, and whether a repeated fill of the same outcome within 5 minutes has the same, higher or lower price. These are not exact submitted limit-order updates.
- Price and per-fill notional bucket frequencies and volumes, collected in small per-page JSON summaries, to avoid writing millions of normalized trades to the shared database.
- **Time stability:** compute statistics separately for older half and newer half of the frozen page cohort, then compare them. Distinct markets can share a sporting event, so this is not independent-event out-of-sample validation.

## Storage, safeguards, and truthfulness
- `pi.rn1_sequence_market_state` : one compact row per market in frozen cohort; update absolute values, never add unverified duplicate pages.
- `pi.rn1_sequence_page_stats` : one small stats JSON per page with its immutable SHA.
- `pi.rn1_sequence_jobs` : single frozen cohort, resume cursor, lease, source coverage, errors and completion.
- RLS enabled, no anon/authenticated grants. Protected by the existing backend scheduler token. Analysis pauses if global DB usage exceeds 290 MiB, without affecting the main source archive.
- A single epoch is frozen. After source reaches its true end, a new controlled run can be started for a larger cohort after clearing the old state. Do not claim this first cohort covers RN1's entire trading history.

## Hypothesis testing for RN1
- **Inventory skew sensitivity:** does he more often buy the underweight outcome (and actually reduce gap) once the observed gap is large?
- **Passive quote persistence:** do repeated fills on the same outcome arrive at identical prices within minutes, consistent with standing liquidity, or does he frequently change prices?
- **Opposite-side timing:** is the first opposing fill typically within 1/5/15/60 minutes? Test across disjoint time cohorts.
- **Not proven:** maker quote selection vs unavailable best bid, expected sporting return, or genuine PnL net of inventory/rebates.
- Future decisive data: contemporaneous CLOB best bids/asks or order modifications, sports-event status, complete transaction/inventory flows and event-clustered holdout.

Run status: `select job_key,status,pages_done,cohort_last_page,observed_fills,last_error from pi.rn1_sequence_jobs`.
