# Dodo reconciliation and fulfillment (stage 5)

`reconcileClaim` (`convex/billingReconcile.ts`) turns a stage 4 claim into money-correct
state. It reads the reconciler config (`readConvexBillingConfig("convex-reconciler")`) and
does nothing when the config is missing, its mode differs from the customer's, or the
customer has no provider id: receipts stay pending and back off. Otherwise it reads the
current payment and subscription for each `payment.*` and `subscription.*` receipt in claim
order, at most 20 reads per claim; receipts past the budget stay pending for the next claim.
A failed read (any status, timeout or malformed body) is never a business outcome: it is
logged with ids and status, the receipts that need it stay pending (backoff, then a
redrivable dead-letter), and the rest of the claim still commits. `refund.*` and `dispute.*`
receipts stay pending until stage 8. Event names and order are never trusted: only
`decideSettlement` on a fresh read decides a grant.

`commitReconciliation` (`convex/billingFulfill.ts`) applies the facts in one transaction:

- **Stale.** A changed generation or revision, or a receipt that is not this customer's and
  pending, returns `stale` with no writes.
- **Fenced positives.** A grant for a live owner commits only under that unchanged fence, with
  no hold, no pending or quarantined refund or dispute for the customer, no unmapped refund or
  dispute naming the payment (a full bounded read blocks), and no account enabled in the other
  mode. Pending positives left for later claims do not block, so a backlog drains. A blocked
  payment writes nothing and keeps its receipts pending while everything else commits
  (`blocked`). A business outcome never throws.
- **Exactly once.** A payment matches its purchase by payment id, then by an unbound checkout
  session. Only a settlement binds a payment to a checkout, so a declined attempt leaves the
  session to its retry. A Pro payment for an owned subscription with no purchase gets a
  server-created `renewal:<payment>` purchase; any other unmatched payment, including a second
  payment for an already settled checkout, is recorded quarantined. A settled purchase never
  grants again. A grant from another purchase for the same period, or another subscription still
  paid through it (active, cancelled or expired), quarantines the purchase. Every purchase
  quarantine is logged with ids and reason.
- **Grant.** The account is enabled first (`paidCreditsVersion` and `paidCreditsMode`, with
  this month's Free state stored from legacy usage), so the grant pays off debt. The amount is
  the purchase's immutable `terms.credits`. Periods get a `current_period` lot plus the capped
  rollover; top-ups expire 12 months after settlement. The plan stays as it is. A deleted
  owner's purchase settles with `cancellationRecoveryRequired` and grants nothing.
- **Non-grant outcomes.** Processing, failed and cancelled update only a purchase already bound
  to that payment. A zero-amount charge with no purchase of its own is final and records nothing.
  A payment matching another customer's purchase is final and alerted: it never writes that
  purchase and never holds this customer's fence.
- **Subscriptions.** Cancelled, expired and failed statuses end the row, `cancelAt` follows the
  provider, `paidThrough` never shrinks, and a replay never reactivates an ended row.
- **Receipts.** A receipt is processed when all its resources reached a final outcome. Other
  mismatches quarantine it as `unsupported`: counted unresolved for support, but only a refund or
  dispute blocks grants.
