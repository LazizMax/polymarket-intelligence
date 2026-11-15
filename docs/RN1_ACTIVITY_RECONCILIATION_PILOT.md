# RN1 Research — public activity feed pilot and economic reconciliation limits

Wallet: `0x2005d16a84ceefa912d4e380cd32e7ff827875ea`

## New capabilities
- Archives source JSON + request context for `GET https://data-api.polymarket.com/v2/activity?user=...&start=1&limit=200`.
- Cursor-based recent-first pages; separate private `pi.rn1_activity_pages` and `pi.rn1_activity_import_state`. Up to 4,000 observed rows, 2 pages per run, resumable and lease-protected.
- Stores normalized activity in `pi.wallet_activity` with `kind` equal to the **original type**, source-reported `usdc_size`, market, token, transaction hash (where provided), timestamp and raw-page + ordinal provenance.
- Shows observed counts for `TRADE`, `REDEEM`, `MERGE`, `SPLIT`, `REWARD`, `MAKER_REBATE`, `TAKER_REBATE`, `YIELD` or other types **if actually present**. No absent category is inferred to be zero historically.
- Checks whether the source activity TRADE appears to match one observed trade by wallet, transaction hash, token, side, size and price. This is a correspondence check, **not** unique on-chain fill identity and never adds a second independent trade.
- For REDEEM, reports source's `usdc_size` as **reported gross payout**, not profit. Matching a token in our trade sample does not establish complete acquisition cost. The baseline is incomplete; opening inventory may predate the pilot.

## No claims of confirmed profit
- Neither fee amount nor maker/taker flag is present for individual V2 `/trades` rows.
- `/activity` can describe payouts and incentives, but trading cost, prior balance, withdrawals, transfers, and merges across the complete lifetime are not reconciled.
- All new rows have `amount_usdc = NULL`, `amount_classification = 'unknown'`. `reported_usdc_size` is a separate *source observation*, not a verified cash-flow ledger or PnL.
- Raw rows may share a transaction hash. Archive source page/ordinal separately and do not deduplicate on transaction hash.
- Do not compare a 4,000 trade page pilot and a 4,000 activity page pilot as if they cover exactly the same UTC period. Their ordering, frequency and density differ.

## Guardrails / operations
1. Additive migration `sql/021_rn1_activity_pilot.sql` in **private** `pi` schema with RLS and no grants for anon/authenticated.
2. Deploy matching `pi-ingest` and `pi-dashboard` Edge Functions; keep Vault scheduler credential confidential.
3. Run one scheduler-authenticated pilot manually and validate raw archives, counters, and data quality.
4. Start independent Cron `sql/022_rn1_activity_pilot_schedule.sql`, every two minutes, conditional on `status='collecting'`. Stops sending requests automatically after 4,000 rows or source exhaustion; Cron SQL stays scheduled for potential later research.
5. Publish RN1 UI in existing GitHub Pages. Do not change any other wallet ingestion, ROI, or Fit Tracker workflow.

## Next scientific stage
Once a sufficiently complete chronology is gathered: audit all relevant historical trades and on-chain balance-changing events, reconstruct signed token inventory per condition; validate event resolution and token payoff, then allocate realized cost to actual matched inventory and separate rewards from trading gains. Before that stage, score RN1 as `unreconciled` and do not propose a profitable copy-bot.
