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

## Residual risks

- Checkout hosts are `test.checkout.dodopayments.com` (test) and
  `checkout.dodopayments.com` (live), per the provider docs; the SDK does not
  pin them. A different host fails closed (URL dropped, session kept, lock
  held) until confirmed against a test-mode checkout.
- The provider exposes no checkout expiry, so `expiresAt` is normally absent
  and a held lock waits for settlement, a definite failure, or later recovery.
- An `unknown` customer or purchase needs support until the recovery stage.
