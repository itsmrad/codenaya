# Refunds, disputes and holds (stage 8)

Implements ADR 0016's refund and dispute rules: 8a reads and decides (items
1-5), 8b commits (items 6-10). Refund and dispute receipts, from webhooks or
polling, resolve from a fresh read of their payment and stop blocking grants.

1. **Reads.** `fetchPayment` (`src/features/billing/server/dodo-reads.ts`)
   normalizes the payment's whole current `refunds` and `disputes` lists into
   `adjustments` (dodopayments SDK 2.63.0: both are required arrays on
   `GET /payments/{id}`). A missing list, more than 20 entries in a list, or any
   malformed entry leaves `adjustments` undefined (unknown, never empty). An
   entry of another payment or business fails the whole read as permanent, so
   another payment's refund is never counted. Dispute statuses drop their
   `dispute_` prefix; unrecognised statuses become `other`.
2. **Counting.** `src/features/billing/reversals.ts` (pure). Succeeded refunds
   and lost or accepted disputes count. Per payment the reversed amount is
   `min(total, sum of counted amounts)`, and the credits to revoke are
   `floor(credits × reversed / total)` over the cumulative amount, exact on a
   full reversal. A succeeded refund without an amount counts as the full total
   only when it is not partial.
3. **Fail closed.** A refund in an unrecognised status, or a counted entry
   without a usable amount or in a currency other than the payment's (an absent
   currency included), makes the reversal `unknown`. Dodo documents no unit for
   a dispute amount, so it is usable only when it equals the payment's gross
   total as minor units (`"2000"`) or as major units (`"20"`, `"20.00"` for USD
   20.00): a full dispute. An unknown reversal applies nothing (item 9).
4. **Dispute holds.** An opened, challenged, expired or unrecognised dispute
   holds the customer; won, cancelled, lost and accepted release it. Holds are
   per dispute.
5. **Discount guard.** Settlement quarantines a would-be period or top-up grant
   (reason `discount`) when the payment carries a discount (`discount_id`, or
   the first of `discounts`; an unreadable one counts as a discount without
   failing the read), or when a USD total is below the list price in
   `plans.ts`. Totals include tax, so an undiscounted USD payment is never below
   the list price. This is defence in depth: checkout (stage 9) disables
   discount codes.
6. **Adjustment rows.** Each commit records every refund and dispute of each
   read payment in `billingAdjustments`, one row per provider id. A row's
   counted amount never decreases: a counted refund later shown failed, or
   dropped from the list, stays counted (and is logged). The payment's reversed
   amount is the capped sum over its rows, so a repeated finding never applies
   twice.
7. **Revocation** (`convex/billingReversals.ts`). Against the original
   purchase's lots, never the current plan: only `target − revokedCredits` is
   revoked, from the purchase's rollover lot first, then its own lot (expired
   lots too: expiry alone never creates debt). Credits already spent become
   `creditDebt`, recorded only on an account billing-enabled in the customer's
   mode and never for a deleted owner (logged instead). A full reversal marks
   every lot of the purchase `fullyReversed`, which ends that paid period.
   Credits are never restored.
8. **Same transaction.** Reversals apply right after settlement in the same
   commit, and the purchase is re-read by payment id, so a refund seen with its
   payment (or before it) is never spendable. A refund or dispute receipt this
   commit resolves no longer blocks the customer's grants; any other unresolved
   one, and every quarantined one, still does. When such a negative resolves
   while its payment's own grant waits on another fence reason, the commit
   queues one internal `payment.reconcile` receipt for that payment (unless it
   is settled or another positive receipt names it), so the payment is read
   again and settles net of its reversal once the fence clears.
9. **Unknown and foreign.** An unknown reversal writes nothing: its receipts
   stay pending (backoff, then dead letter) and that payment's grant waits. A
   refund or dispute whose payment belongs to another provider customer is
   quarantined `unsupported` for support; another customer's purchase is never
   written.
10. **Holds.** An active dispute row is a hold on that customer row (so per
    mode), one per dispute. It refuses new checkouts and the resume of an open
    one (`prepareCheckout` returns `refused/on_hold`, `reservePurchaseRow`
    throws `FORBIDDEN`). It never blocks grants: a settled renewal still grants,
    and spending during a hold is frozen at the inference gates (stage 11).
    `expired` keeps the hold until support releases it; won and cancelled
    release only that dispute's hold; lost and accepted release it and reverse.

Operators: support holds, releasing a reviewed dispute hold and resolving stuck
receipts come with the operator mutations (stage 8c).

## Residual risks

- Non-USD payments are caught by the discount id alone; there is no price check
  in other currencies.
- The provider does not link a refund to a dispute over the same money. A partial
  refund plus a lost dispute of the same slice are summed and capped only at the
  total: a conservative over-reversal that support can correct.
- A counted refund the provider reports without an amount (partial) or currency
  stays unknown, which keeps that payment's grant blocked until a later read is
  known or an operator resolves it.
- An unknown reversal that never becomes known dead-letters its receipt, which
  keeps blocking that customer's grants until an operator resolves it.
- A dispute hold is recorded here, but freezing platform-funded spending during
  it is enforced at the stage 11 access gates. Billing must not launch on this
  stage alone.
