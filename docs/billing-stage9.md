# Checkout bridge (stage 9)

Implements the Convex side of ADR 0016's checkout: the server-only bridge a
Next route calls to start a Pro or top-up checkout. Billing stays off
(`CODENAYA_BILLING_ENABLED` unset), and nothing calls the bridge yet; the Next
route (`POST /api/billing/checkout`) builds on it.

## Bridge (`convex/billingCheckout.ts`)

Three public mutations. Each requires the internal key **and** the caller's
Clerk-issued Convex JWT; the owner is `identity.tokenIdentifier` /
`identity.subject`, never an argument. A customer or purchase ref that is not
the caller's is `NOT_FOUND`. None of them calls the provider: Next creates the
provider customer or checkout between calls and records the outcome.

- **`prepareCheckout({ mode, sku, productId })`** decides the next step:
  1. Catalog: `mode` and `productId` must match Convex's own reconciler config
     (the catalog settlement checks), else `refused/unavailable`. Then the
     owner's customer row is ensured (`FORBIDDEN` for a held or deleted owner).
  2. Lock held (`pendingPurchaseRef`): an `open` purchase with a stored URL, not
     past `expiresAt`, for the same sku → `resume` with that URL; otherwise
     `pending`. A `preparing` purchase older than `CHECKOUT_PREPARE_STALE_MS`
     (2 min) becomes `unknown` (a crashed route may have created a session) and
     keeps the lock.
  3. Refusals, before any customer is created: Pro with a subscription that is
     `pending`/`active`/`quarantined` or paid through now → `already_subscribed`
     (fails closed past the read bound); top-up outside a paid period →
     `not_pro`; top-up with `MAX_ACTIVE_LOTS.top_up` (100) active top-up lots →
     `top_up_cap`, counted by `countActiveLots` from the same index and
     predicate allocation reads.
  4. Customer: `unknown` → `support_required`; `preparing` without a lease →
     new lease → `create_customer { customerRef, leaseId }`; with a lease
     younger than `CUSTOMER_LEASE_STALE_MS` (2 min) → `pending`; older →
     `unknown` → `support_required`.
  5. Reserve a purchase with a fresh `intentId` and catalog terms (quantity 1,
     2,000 or 1,000 credits, `BILLING_CATALOG_VERSION`) →
     `create_checkout { purchaseRef, intentId, customerId }`, where
     `customerId` is the provider customer bound to the caller's own row.
- **`recordCustomerResult({ customerRef, leaseId, result })`**: the lease must
  match (`CONFLICT` otherwise). `created` binds the provider customer and clears
  the lease, unless that ID is already bound to another row (the provider may
  return an existing customer): then the row becomes `unknown`, nothing is
  bound. `not_created` (definite 4xx) clears the lease; `unknown` (lost
  response) marks the row `unknown` and keeps the lease for support. An
  `unknown` row accepts only a late `created`.
- **`recordCheckoutResult({ purchaseRef, result })`**: the purchase must be the
  caller's locked `preparing` or `unknown` purchase. `created` binds the
  `sessionId` (and `expiresAt` if given), stores the checkout URL only if it is
  `https:` on the mode's Dodo checkout host (`src/features/billing/checkout-url.ts`),
  and marks it `open`. `not_created` marks it `terminal` and releases the lock;
  `unknown` keeps the lock. An `unknown` purchase accepts only a late `created`.

Provider IDs from Next are re-checked (`/^[A-Za-z0-9_-]{1,128}$/`); a malformed
ID counts as a lost response. No path binds a `paymentId`: only settlement does.
The lock is released only by settlement, a definite `not_created`, or (later
stages) provider evidence or an audited operator action; never by time or the
browser.

## Shared changes

- `convex/billing.ts`: the bodies of `ensureCustomer`, `bindCustomer`,
  `reservePurchase` and `bindPurchase` are now exported helpers
  (`ensureCustomerRow`, …) the mutations call unchanged; `requireActiveOwner` is
  exported.
- Schema (additive): `billingPurchases.checkoutUrl`,
  `billingCustomers.creationLeasedAt`.

## Provider polling (`convex/billingPoll.ts`)

A 15-minute cron (`selectPollTargets`) picks at most 20 due customers of this
deployment's mode (`by_mode_and_nextPollAt`) and schedules one `pollCustomer`
action each. The action makes at most 10 provider reads, so a cron run makes at
most 200:

- one page (20 items) each of the customer's payments, refunds, disputes and
  subscriptions created within a fixed **window**
  `[since, until]`, where `since = (lastPolledAt or creation, or the held
  purchase if older) − 3 days` and `until` is when the window opened;
- `GET /checkouts/{id}` for a held `open`/`terminal` purchase;
- up to 3 of our own `pending`/`active` subscriptions by id, whatever their age,
  so a missed cancellation or expiry of an older subscription is caught;
- up to 2 payments that still have an unresolved refund or dispute receipt, so
  a later refund or dispute status is seen.

A full page does not stall the window: the next run reads the next page
(`page_number`, 0-based offset paging) of only the unfinished lists, in the same
window. Offsets stay stable because the window's item set is fixed, assuming the
provider orders lists by creation time (undocumented). When every list is read,
the window closes and `lastPolledAt` becomes its `until`. A failed page is read
again next run. A list still full after `MAX_POLL_PAGES` (50) pages ends the
window without release evidence: the lock is kept and an error is logged for an
operator.

`recordPollFindings` records **synthetic receipts** through the same
`recordReceiptRow` helper the webhook uses, so every money effect still runs
through the queue and the fenced commit:

- a succeeded payment no purchase has bound (`payment.poll`), unless a pending
  or quarantined positive receipt for it already exists;
- a succeeded refund or any dispute status (`refund.poll`, `dispute.poll`;
  they stay fenced like their webhooks until reversal handling lands); another
  receipt of the payment never suppresses them;
- a subscription with no local row, or that the provider shows ended while the
  local row is not (`subscription.poll`).

`webhookId` is `poll:<kind>:<id>:<status>` with the digest of that text, so a
resource is recorded once per observed status. A failed payment is never
recorded; a poll never extends `paidThrough`.

**Who is polled.** A held lock, a window still paging, or a subscription within
48 h of `paidThrough`: every 15 min. An active subscription, or a customer
whose reversal watch (`watchUntil`, 120 days after any settlement, top-ups
included) is open: every 6 h. Nobody else (`nextPollAt` cleared). Checkout
results and settlements make the customer due.

**Lock release.** The provider exposes no checkout expiry, so release uses its
documented default: a session expires 24 h after creation
(`CHECKOUT_SESSION_TTL_MS`, from the session read's `created_at`). The lock is
released (purchase `terminal`, `pendingPurchaseRef` cleared) only when:

- the window was fully read, and this run had no failed read;
- the window ends more than 24 h plus a 5-minute clock-skew margin after the
  session's creation (or after a later `expiresAt`), so every payment and
  subscription the session could have made is in it;
- no page of the window listed a payment created since the purchase (minus the
  margin) in any status but failed or cancelled, unless it is a succeeded
  payment already bound to another purchase of another session (a renewal, an
  earlier top-up);
- for Pro, no page listed, and no re-read showed, a subscription since the
  purchase in any status but cancelled, expired or failed (unknown statuses
  count as live);
- the held purchase is still `open`/`terminal` with the same session and no
  bound payment, and the session shows no payment or only a failed/cancelled one.

`preparing`, `unknown`, `processing` and `settled` purchases are never released
here. A payment that arrives after a release still settles once against the
released purchase by its session ID (top-up and Pro).

## Residual risks

- Checkout hosts are `test.checkout.dodopayments.com` (test) and
  `checkout.dodopayments.com` (live), per the provider docs; the SDK does not
  pin them. A different host fails closed (URL dropped, session kept, lock
  held) until confirmed against a test-mode checkout.
- The provider exposes no checkout expiry; lock release relies on its
  documented 24 h session default plus a fresh session read. If that default
  changed, a lock could be released while the hosted page still accepts
  payment; such a payment still settles against the released purchase, and a
  second Pro checkout meanwhile is caught by the duplicate-period guard.
- A list page the provider keeps rejecting (for example past an offset cap)
  keeps its window open and the lock held; it is logged every run.
- Only 3 known subscriptions and 2 reversal payments are re-read per poll, and
  always the same ones while their receipts stay unresolved. A later status
  change of a 4th subscription or a 3rd disputed payment is not seen by polling
  (lists only show resources created in the lookback); its webhook or support
  covers it.
- An `unknown` customer or purchase needs support until the recovery stage.


## Unknown checkout recovery

A fresh payment read normalizes `metadata.purchaseId` as a bounded intent hint.
Fulfillment first matches the payment or session id. Otherwise it may locate only
that customer's pending `unknown`/`preparing` intent, with matching sku and no
bound session or payment. The hint grants nothing by itself: customer, product,
settlement terms, deduplication and the reconciliation fence still apply. Poll
receipts follow this same path. A stale preparing intent becoming unknown is
also marked due for polling. Unknown customer creation needs operator review;
email matching never binds an identity.

## Audited operator recovery

`billingOperator.resolveUnknownCustomer` accepts only an unknown creation. After
checking the dashboard, support supplies the verified provider customer id, or
omits it only when no customer was created. Binding retains provider-id uniqueness;
resetting clears the creation lease. The customer stores the resolution audit.

`billingOperator.releaseCheckoutLock` requires dashboard confirmation that the
checkout is expired and unpaid. It refuses processing/settled purchases and any
purchase with a payment id; ownership and mode must match the locked customer.
It marks the purchase terminal and clears the lock atomically, storing the audit
on the purchase. The retained session id lets a late payment settle normally,
once, without clearing a newer checkout's lock.

Both are internal mutations, with operator alias (1–64 characters, no `@`), reason
(1–500 characters), action and timestamp. Logs contain ids/action/operator only.
Production calls require explicit approval for each run. Manual dashboard review
is a trust boundary: these mutations do not query Dodo or prove the review happened.
No new environment variables, automatic create retries or billing enablement.
