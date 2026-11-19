# Dodo reconciliation and fulfillment (stage 5)

`reconcileClaim` (`convex/billingReconcile.ts`) turns a stage 4 claim into money-correct
state. It reads the reconciler config (`readConvexBillingConfig("convex-reconciler")`) and
does nothing when the config is missing, its mode differs from the customer's, or the
customer has no provider id: receipts stay pending and back off. Otherwise it reads the
current payment and subscription for each `payment.*` and `subscription.*` receipt in claim
order, at most 20 reads per claim; receipts past the budget stay pending for the next claim.
A retryable read error fails the whole claim; a permanent one records the resource as
unreadable. `refund.*` and `dispute.*` receipts stay pending until stage 8, which keeps grants
fenced. Event names and order are never trusted: only `decideSettlement` on a fresh read
decides a grant.

`commitReconciliation` (`convex/billingFulfill.ts`) applies the facts in one transaction:

- **Stale.** A changed generation or revision, or a receipt that is not this customer's and
  pending, returns `stale` with no writes.
- **Fenced positives.** A grant for a live owner commits only when the customer has no hold,
  no unmapped refund or dispute names the payment, the credit account is not enabled in the
  other mode, and marking this commit's receipts brings `unresolvedReceipts` to 0. Otherwise
  those payments write nothing and keep their receipts pending, everything else commits, and
  the result is `blocked`. A business outcome never throws.
- **Exactly once.** A payment matches its purchase by payment id, then by checkout session.
  A Pro payment for an owned subscription with no purchase gets a server-created
  `renewal:<payment>` purchase; any other unmatched payment is recorded quarantined. A settled
  purchase never grants again. A grant from another purchase for the same period, or another
  subscription paid through the period, quarantines the purchase.
- **Grant.** The account is enabled first (`paidCreditsVersion` and `paidCreditsMode`, with
  this month's Free state stored from legacy usage), so the grant pays off debt. Periods get a
  `current_period` lot plus the capped rollover; top-ups expire 12 months after settlement. The
  plan stays as it is. A deleted owner's purchase settles with `cancellationRecoveryRequired`
  and grants nothing.
- **Subscriptions.** Cancelled, expired and failed statuses end the row, `cancelAt` follows the
  provider, and `paidThrough` never shrinks.
- **Receipts.** A receipt is processed when all its resources reached a final outcome.
  Unreadable or other-customer facts quarantine it as `unsupported`, still counted unresolved.

## Early receipts (5c)

A verified receipt whose provider customer is not mapped yet is stored `quarantined`
(`unmapped`) with its payload's `providerCustomerId`. Dodo saw a 2xx and will not redeliver, and
a replay of the same event is a duplicate, so `associateUnmappedReceipts` (`convex/billing.ts`)
attaches these rows through our own bindings only, never metadata or email:

- `bindCustomer` attaches by provider customer id, also for a deleted or held owner, whose
  receipts still need processing for suppression and recovery.
- `bindPurchase` attaches by payment id when it binds one. A row whose stored provider customer
  differs from the customer's never attaches.
- A same-digest redelivery that now maps attaches the existing row. A different digest marks an
  unmapped row `digest_mismatch` and leaves it unmapped.
- `commitReconciliation` attaches by payment id for each positive payment (whose read showed this
  customer) before any grant. If anything attached, no positive commits in that transaction.

An attached `unmapped` row becomes pending; a `digest_mismatch` row stays quarantined for an
operator. Both are counted in `unresolvedReceipts`, and the customer's `inputRevision` moves once,
so positives stay fenced until they resolve. Batches of 50 continue through
`associateMoreUnmapped` after the last row seen.
