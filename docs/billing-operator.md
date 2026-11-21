# Billing operator recovery

These functions are internal mutations in `billingOperator`. Run them with
`npx convex run billingOperator:<function> '<json>'`. Every production invocation
requires explicit approval. Use a non-email operator alias (1–64 characters) and
a review reason (1–500 characters). Reasons are stored in the audit, never logged.
Rows keep the latest operator audit with fresh `previousState`, rather than an audit history.

- `resolveReceipt({eventRef, action: "attach" | "dismiss", operator, reason})`
  repairs quarantined receipts. Attach uses the purchase bound to the payment in
  the receipt's mode, even when the payload's customer conflicts. It can move an
  unsupported negative from the wrong parent. Digest mismatches stay quarantined
  for a separate reviewed redrive. Dismiss refuses mapped negatives and unmapped
  receipts with a bound purchase.
- `placeSupportHold({customerRef, operator, reason})` returns an adjustment id.
  Place it before initiating a dashboard refund. Each hold is independent.
- `releaseHold({adjustmentRef, operator, reason})` releases a support hold, or a
  reviewed dispute with status `expired` or `other`. A different provider status
  invalidates that dispute override. It does not restore reversed credits.
- `resolveUnreadableReversal({customerRef, eventRef, generation, inputRevision,
  amountMinor, operator, reason})` resolves an owned, dead-lettered negative
  after manual review. Read the customer's current generation and input revision
  before invoking it; a changed fence refuses the write. The bound purchase must
  have a known positive gross total. `amountMinor` is the reviewed **cumulative
  reversal of the whole payment**, not an incremental debit. It must be an integer
  between zero and the gross total. Use `null` to record no reversal with a reason; it is stored distinctly from a reviewed zero.
  Gross is saved from verified payment reads, never reconstructed from principal;
  older rows without it refuse with `CONFLICT` until reconciled. A reviewed receipt
  authorizes a queued payment retry to settle net of that cumulative reversal even
  when the amount remains unreadable. New unresolved negatives still fence grants.
  Existing reversals never decrease; repeated amounts do not revoke twice, and
  processed receipts cannot be targeted. The normal reversal path handles rollover,
  debt and fully reversed periods. Other unresolved negatives remain fenced.

No operator function writes refunds or disputes to the provider.
