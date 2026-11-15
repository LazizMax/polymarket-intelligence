# RN1 maker/taker execution audit

The public Data API defaults to `taker_only=true`. For each source page previously archived with `taker_only=false`, this audit fetches an official `taker_only=true` subset for the **same UTC timestamp bounds**.

**Verified control (15 November 2026, 02:23:58–03:52:46 UTC):** 1,000 full-wallet rows, 122 taker-only rows, all 122 match the full feed on transaction hash + token id + direction + price + size + timestamp + condition. The 878 extra rows (87.8%) are maker-only **by public API set difference**, not by a raw on-chain maker flag.

### Procedure
- Reopen the original private gzip object, decompress, verify SHA-256 against the Postgres page entry and verify the original row count.
- Fetch `/v2/trades?user=<RN1>&start=<minTimestamp>&end=<maxTimestamp>&limit=1000&taker_only=true`, walking all pages for this bounded window, up to a safe limit.
- Match fills as a **multiset**, never simply by transaction hash. There may be several fills of the same order/transaction.
- Record inferred maker/taker counts only when the taker-only cursor was exhausted. Record `partial` or `error` otherwise; never treat incomplete pages as verified.
- Retry failed pages safely, with a bounded count and DB lease; initial pages and newly archived pages are both queued.
- Display maker percentage on **verified pages only**, along with coverage, and leave pending pages out of the denominator.
- This identifies transaction *role*, not the exact limit price placed, time in queue, unexecuted maker orders, maker fees, or the bot's private prediction model. No profit claim.

SQL: `030_rn1_maker_role_audit.sql`, schedule: `031_rn1_role_audit_schedule.sql`. Test source: `rn1-maker-match_test.ts`.
