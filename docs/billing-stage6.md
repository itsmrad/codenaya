# Paid credit grants and charge allocation (stage 6)

Implements ADR 0016's paid-lot storage and spending order. Feature stays off:
nothing outside tests sets `creditAccounts.paidCreditsVersion` (or
`paidCreditsMode`), so every existing account, Free or Pro, is charged exactly as
before. Enabling it must wait for Free-allocation-first accounting and debt
offset by new grants; `src/features/billing/grants.test.ts` fails if source
starts writing either field.

`billingGrants` holds one lot per settled period, rollover or top-up, unique per
`(mode, sourceKey)`. `quantity` is immutable; spending raises `consumed`, and later
reversal stages raise `revoked`. `insertGrant` (`convex/billingGrants.ts`) is a
plain helper so fulfillment can run it inside the mutation that checks the
billing fence: same key and terms return the original row, changed terms conflict.

`recordRunUsage` keeps the per-run cumulative max-total meter. When an account has
`paidCreditsVersion` and `paidCreditsMode`, the new positive credit delta (and
each dictation charge) is allocated in the same mutation to lots of that mode
only: current period, then rollover, then the earliest-expiring top-up, equal
expiries by grant id. Expiry uses server time. Anything the lots cannot cover is
added to `creditDebt`, which a calendar period reset keeps; usage counters still
record the full charge. A replayed total adds no delta, so it allocates nothing.

Reads are bounded by `MAX_ACTIVE_LOTS` per kind (2 period, 2 rollover, 100 top-up
lots), in spending order. Lots beyond a cap expire no earlier than those read, so
a capped kind spends its read lots and the charge stops there: no later kind is
spent while the capped kind may still hold unread credits. The remainder becomes
`creditDebt` with a `console.warn` naming the user, mode and kind, so support can
consolidate lots and reverse the debt. The charge never fails for overflow:
callers ignore a failed charge, so throwing would drop the usage row entirely.
Checkout must refuse new top-ups at the cap.

Later stages own debt offset by new grants, Free allocation accounting for
billing-enabled Free accounts, rollover/expiry policy, reversals and entitlement.
