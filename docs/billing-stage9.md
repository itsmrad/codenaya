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
action each. The action makes at most 6 provider reads: the customer's
payments, refunds, disputes and subscriptions created since
`(lastPolledAt or creation, or the held purchase if older) − 3 days` (first
page, 20 items), and `GET /checkouts/{id}` for a held `open`/`terminal`
purchase. `recordPollFindings` then records **synthetic receipts** through the
same `recordReceiptRow` helper the webhook uses, so every money effect still
runs through the queue and the fenced commit:

- a succeeded payment no purchase has bound (`payment.poll`);
- a succeeded refund or any dispute (`refund.poll`, `dispute.poll`; they stay
  fenced like their webhooks until reversal handling lands);
- a subscription with no local row, or that the provider shows ended while the
  local row is not (`subscription.poll`).

`webhookId` is `poll:<kind>:<id>:<status>` with the digest of that text, so a
resource is recorded once per observed status. Nothing is recorded while an
unresolved (pending or quarantined) receipt for the same payment exists. A
failed payment is never recorded; a poll never extends `paidThrough`.

**Who is polled.** A held lock or a subscription within 48 h of `paidThrough`:
every 15 min. An active subscription, or a customer whose reversal watch
(`watchUntil`, 120 days after any settlement, top-ups included) is open: every
6 h. Nobody else (`nextPollAt` cleared). Checkout results and settlements make
the customer due; `lastPolledAt` advances only after a complete poll (no read
failure, no full page).

**Lock release.** The provider exposes no checkout expiry, so release uses its
documented default: a session expires 24 h after creation
(`CHECKOUT_SESSION_TTL_MS`, from the session read's `created_at`). The lock is
released (purchase `terminal`, `pendingPurchaseRef` cleared) only when the
poll was complete, the held purchase is still `open`/`terminal` with the same
session and no bound payment, the session is past 24 h (or a later
`expiresAt`), the session shows no payment or only a failed/cancelled one, no
unbound succeeded payment was listed, and, for Pro, no
`pending`/`active`/`on_hold`/`paused` subscription was created since the
purchase (with a 5-minute clock-skew margin). `preparing`, `unknown`,
`processing` and `settled` purchases are never released here. A payment that
arrives after a release still settles once against the released purchase by
its session ID.

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
- Only the first page (20) of each list is read; a fuller page is logged and
  keeps the lock until later polls narrow the window.
- An `unknown` customer or purchase needs support until the recovery stage.
