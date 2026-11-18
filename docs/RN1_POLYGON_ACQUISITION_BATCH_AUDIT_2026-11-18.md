# RN1 Polygon acquisition: live 108-transaction audit (2026-11-18)

## Goal
Reconcile real Polygon ERC20 pUSD outflows and CTF ERC1155 share receipts to RN1's original 111 BUY fills from the independently selected eight settled markets, without mixing incomplete acquisition samples with whole-panel redemptions.

## Evidence, scope, and storage
- Original archived fills: 111 BUY fills aggregating to 108 distinct transaction hashes (3 transactions each contain 2 fills); no hash overlaps the eight selected markets.
- Gross archived BUY cost: 37,067.028410 pUSD-equivalent units.
- Existing 8/8 earlier sample checks were preserved. These are not re-collected or overwritten.
- Queue: `pi.rn1_chain_acquisition_queue`, private RLS, no anon/authenticated rights.
- Expected CTF ERC1155 token position IDs: calculated through onchain `getCollectionId` + `getPositionId` for each binary outcome, keyed by conditionId and USDC.e collateral; cached privately in `pi.rn1_chain_token_map`.
- Worker: `supabase/functions/pi-rn1-acquisition-batch/index.ts`; `pi-rn1-acquisition-batch` v2 deployed. Auth: SHA256 check of header `x-pi-scheduler-token` against `pi.scheduler_auth`.
- Chronological claims: atomic `FOR UPDATE SKIP LOCKED` and 3-minute lease, bounded retries.
- Each receipt: independently fetch `eth_getTransactionReceipt` and `eth_getTransactionByHash`, require matching hash and status 1. Sum only RN1's ERC20 outgoing pUSD, and check RN1's net ERC1155 movement **for the exact token ID** corresponding to the archived outcome. Leave ambiguous/batched mismatches unverified. Store fee-topic counts without attributing anyone else's fees to RN1.
- Raw evidence stored as proper JSONB objects, following fix in v2.
- Scheduler: private pg_cron job `pi-rn1-acquisition-audit-1min`, every minute, asks worker to process at most two transactions if pending; token obtained from Vault in the database, not embedded in files.

## Direct verification
First new non-sampled transaction `0xd030a6a466df8002c2317d1aa68c522ad06601e4a74e89ee987d7b743d36a8e3` (market W35 Hurghada):
- expected = observed direct wallet pUSD debit: 0.992800
- expected = observed RN1 ERC1155 net share receipt of exact outcome token: 1.360000
- wallet not tx gas payer; direct receipt status 1.
- Worker returned HTTP 200, `verified`; independent SQL verified evidence shape and queue progression. Scheduler jobid 21 ACTIVE and ran with status `succeeded`.

**Important:** The queue's `verified` status means acquisition flow matched, NOT net Maker profitability. Full-eight-market ROI after fees still requires all buys (including any ambiguous), earlier direct settlements, maker vs taker classification, rebates and possible off-ledger transfers; do not subtract a partial set of BUY debits from full-panel payouts. Keep pilot vs holdout independence and do not infer a copy-trading signal from a handpicked profit sample.
