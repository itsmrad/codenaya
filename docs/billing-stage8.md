# Refund and dispute reads, reversal rules, discount guard (stage 8a)

Implements the read side of ADR 0016's refund and dispute rules. Nothing commits
a reversal yet: refund and dispute receipts stay pending, and the reconciler still
skips them. A later stage applies these rules when it commits.

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
   20.00): a full dispute. In this stage nothing consults the decision yet; when
   reversals commit, an unknown reversal applies nothing and blocks that
   payment's grant until a later read is known or an operator resolves it.
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

## Residual risks

- Non-USD payments are caught by the discount id alone; there is no price check
  in other currencies.
- The provider does not link a refund to a dispute over the same money. A partial
  refund plus a lost dispute of the same slice are summed and capped only at the
  total: a conservative over-reversal that support can correct.
- A counted refund the provider reports without an amount (partial) or currency
  stays unknown, which keeps that payment's grant blocked until a later read is
  known or an operator resolves it.
