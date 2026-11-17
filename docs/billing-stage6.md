# Paid credit grants and charge allocation (stage 6)

Implements ADR 0016's paid-lot storage and spending order. Feature stays off:
nothing outside tests sets `creditAccounts.paidCreditsVersion`, so every
existing account, Free or Pro, is charged exactly as before.

`billingGrants` holds one lot per settled period, rollover or top-up, unique per
`(mode, sourceKey)`. `quantity` is immutable; spending raises `consumed`, and later
reversal stages raise `revoked`. `insertGrant` (`convex/billingGrants.ts`) is a
plain helper so fulfillment can run it inside the mutation that checks the
billing fence: same key and terms return the original row, changed terms conflict.

`recordRunUsage` keeps the per-run cumulative max-total meter. When an account has
`paidCreditsVersion`, the new positive credit delta (and each dictation charge) is
allocated in the same mutation: current period, then rollover, then the
earliest-expiring top-up, equal expiries by grant id. Expiry uses server time.
Anything the lots cannot cover is added to `creditDebt`; usage counters still
record the full charge. A replayed total adds no delta, so it allocates nothing.

Reads are bounded by `MAX_ACTIVE_LOTS` per kind (2 period, 2 rollover, 100 top-up
lots). Lots beyond a cap expire no earlier than those read, so they only matter
once the read ones run out. Then the charge fails with `LIMIT_EXCEEDED` rather
than ignore spendable credits or record false debt; checkout must refuse new
top-ups at the cap.

Later stages own debt offset by new grants, Free allocation accounting for
billing-enabled Free accounts, rollover/expiry policy, reversals and entitlement.
