# Checkout bridge (stage 9)

Implements ADR 0016's checkout: the server-only Convex bridge and the Next
route that calls it to start a Pro or top-up checkout. Billing stays off
(`CODENAYA_BILLING_ENABLED` unset), so the route answers 404 until enabled.

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

## Route (`POST /api/billing/checkout`)

Browser input is only `{ sku: "pro_monthly" | "top_up" }`; the answer is
`200 { url }` (Dodo's hosted checkout) or `{ error, code }`, always with
`Cache-Control: no-store`. Order: signed-in (401), same origin (403
`cross_origin`), JSON (415), per-user rate limit `BILLING_CHECKOUT_RATE_LIMIT`
(5/min, 429); billing disabled → 404; enabled but `CODENAYA_DEPLOYMENT` missing
or config invalid → 503 `billing_unavailable`; body (400); top-up while
top-ups are off → 404. Then at most two `prepareCheckout` steps:

- `create_customer`: the Clerk primary email and name (server-side) go to
  `POST /customers` (none → lease released, 409 `email_required`; a Clerk
  failure also releases the lease → 502 `checkout_unavailable`); the result is
  recorded and the loop continues (lost or refused → 502 `checkout_unavailable`).
- `create_checkout`: `POST /checkouts` with the server-chosen product,
  quantity 1, the bound customer, the fixed `DODO_PAYMENTS_RETURN_URL`,
  `metadata { purchaseId: intentId, purpose: sku }` and
  `feature_flags.allow_discount_code: false`. Created with an allowed URL →
  200; created without one → 502 `checkout_unavailable`; lost → 502
  `checkout_unknown`; definite 4xx → 502 `checkout_failed`.
- `resume` → 200; `pending` → 409 `checkout_pending`; `refused` → 409 with its
  code, or 503 for `unavailable`; `FORBIDDEN` → 403 `billing_on_hold`;
  `UNAUTHENTICATED` → 401. Anything unexpected → 500 with fixed text.

Each create is one attempt (`src/features/billing/server/dodo-checkout.ts`,
reusing the read transport: mode host, 15 s timeout, no redirects, bounded
body). A definite 400/401/403/404/422 is `not_created`; anything else is
`unknown` and keeps the lock. If recording a result in Convex fails after a
create, the route answers 502 `checkout_unknown` and never creates again.
Logs carry refs, outcome kinds, config variable names and, for a withheld
checkout URL, its hostname only. The route declares `maxDuration = 60`.

Next needs `CODENAYA_DEPLOYMENT` (`development` locally, `production` on
Vercel Production, unset on Preview) besides the existing billing variables.
`DODO_PAYMENTS_BRAND_ID` stays accepted but is not sent: the checkout create in
`dodopayments` 2.63.0 has no brand field.

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
