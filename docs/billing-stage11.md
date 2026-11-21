# Entitlement and availability (stage 11)

Stage 11 decides plan, permission and spendable credits from settled Convex
state (ADR 0016), never from stored `creditAccounts.plan`, a provider status,
or a caller's clock. This first part adds the shared rule and the server reads.
Nothing calls them yet: the send, run-start, inference and utility gates and
the billing/Usage display switch build on them in later parts.

## Rule (`src/features/billing/entitlement.ts`)

Pure, shared by Convex and the app.

- **`entitlement`**: Pro iff the account is billing-enabled in this
  deployment's mode and holds a period lot with `serviceStart <= now <
  expiresAt` (a period lot's expiry is its `serviceEnd`) that is not
  `fullyReversed`. A spent period stays Pro; a partly reversed one too.
  `paidThroughMs` is the end of the live interval, extended through renewals
  that start before it ends, never across a gap. An early-settled future
  period is not Pro before it starts.
- Permission is separate from plan: deletion gives `reason: "deleted"` and no
  plan; a hold keeps the paid label but `platformAllowed: false`,
  `reason: "on_hold"`.
- **`accountAvailability`**: the full `EntitlementView`.
  - Legacy accounts (no paid markers) get the Free monthly grant and daily cap,
    whatever their stored plan says.
  - In a paid period: active lots minus debt, no daily cap, Free untouched.
  - Off a paid period: this month's Free allocation pays debt first
    (`currentFreeAllocation`), then `paidAccountAvailability` within today's
    cap. This is a projection: the first charge persists the same offset, so
    repeated reads change nothing.
  - `creditsLeft` is 0 when platform use isn't allowed.
  - `nextChangeAt` is the next period start or end or lot expiry; day and month
    resets are their own fields (UTC), and a paid period's end is not a reset.

## Server reads (`convex/billingEntitlement.ts`)

- **`readAccountEntitlement(ctx, userId, now)`**: plain helper for queries and
  mutations. Reads the user row, the user's billing customer in this
  deployment's mode, its holds (`customer.hold` and `hasActiveHold`), the
  credit account, period lots and the same capped active-lot set spending reads,
  so past a lot cap the display never exceeds what spend reaches.
  - Deployment mode comes from `CODENAYA_DEPLOYMENT` alone
    (`deploymentBillingMode`): production is live, others test. Absent or
    invalid: no paid benefits, and every mode's customer is checked for holds.
  - Paid markers are read only through `paidCreditsState`. A half-set pair or a
    marker for another mode gets no paid benefits and logs a fixed code
    (`half_paid_marker`, `foreign_mode_marker`, `deployment_mode_unknown`).
  - Deleted: the user's tombstone, or a billing customer that is deleted or
    whose owner row is gone (as `ownerDeleted` reads it). A user with no row and
    no billing customer (pre-webhook accounts) is not deleted.
- **`getForServer({ internalKey, userId })`** → `EntitlementView`, and the lean
  **`permissionForServer({ internalKey, userId })`** → `{ plan,
  platformAllowed, reason }` (no active-lot scan). Both are mutations so the
  clock is the server's; neither writes, and neither accepts a `now`.

The existing `credits.getMine` / `credits.getForServer` keep their shapes for
current callers.

## Remaining gates

- The billing page summary delegates to `readAccountEntitlement` and the Usage
  display switches to it for enabled accounts once the billing page lands.
- Send, run-start, per-inference and utility gates (later parts) call these
  reads; until then nothing changes for any user.
