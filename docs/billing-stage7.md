# Paid lot policy and Free allocation first (stage 7)

Implements ADR 0016's "Products" and "Free and debt" rules on top of stage 6's
lots. The feature stays off: nothing outside tests sets `paidCreditsVersion` or
`paidCreditsMode`, and the gate test in `src/features/billing/grants.test.ts`
still enforces that (`convex/billingGrants.ts` joins `credits.ts` as a reader).
Legacy accounts are charged exactly as before.

1. **Top-up expiry.** `topUpExpiresAt` returns 12 calendar months after
   settlement in UTC, same time of day, the day clamped to the month's end
   (2028-02-29T10:00Z expires 2029-02-28T10:00Z).
2. **Rollover.** `rollOverIntoPeriod` (called by renewal fulfillment right after
   inserting the new period grant) turns the unspent credits of the period lot
   that ended at the new `serviceStart` into one `rollover` lot: at most 2,000,
   expiring at the new `serviceEnd`, keyed `rollover:<source key>` so a replay
   returns the same row. The source is measured at the boundary (`lotUnspent`
   ignores expiry), because a renewal settles just after it expired; its
   `transferred` rises by the amount. Nothing rolls into a period that has
   already ended, from a source granted after its own end, or from a rollover.
3. **Debt offset.** A new period or top-up grant first pays off `creditDebt`,
   recorded as the lot's `debtOffset`, when the account is billing-enabled in
   the grant's mode. Replays and rollovers offset nothing.
4. **Free allocation.** A billing-enabled account not in a paid period (no
   unexpired, started period lot, spent or not: `isInPaidPeriod`) spends a
   300-credit UTC-month allocation (`freeMonthStartsAt`/`freeUsed`) before its
   lots. Its first touch in a month pays off up to 300 of debt once
   (`freeDebtOffset`). In a paid period the allocation is untouched. Plan changes
   never reset it. Example: 500 debt and a new month leave 200 debt and 0 Free.
   `paidAccountAvailability` is the pure figure for stage 11's send gates: on
   Free, allocation plus lots minus debt within today's 60-credit cap; in a paid
   period, lots minus debt.
5. **Expiry** stays lazy (`expiresAt > now` on read), never creates debt, and
   needs no cron.

Lots never change `quantity`: `consumed`, `revoked`, `transferred` and
`debtOffset` are separate counters, and `exhausted` marks a lot with none left
so it leaves the spend index (`by_userId_and_mode_and_kind_and_exhausted_and_expiresAt`)
and no longer counts toward `MAX_ACTIVE_LOTS`. Every write that empties a lot
sets it; stage 8's revocations must too. The paid-period check and the rollover
lookup read the older index, which still includes spent lots.

Tests: `src/features/billing/grants.test.ts`, `src/features/billing/free-allocation.test.ts`,
`convex/billingGrants.test.ts`.
