# Stage 10a: owned cancellation controls

Cancel schedules the end of renewal; uncancel only removes that schedule while a
settled period remains unexpired and the canonical provider state is active. Holds
block uncancel, but never cancellation. The server chooses the owned active
subscription; requests carry no IDs or timing. Management ignores checkout flags.

Claims serialize opposing operations. Definite refusals release them; confirmed
and ambiguous writes stay pending until the first canonical reconciliation read
that started strictly after the claim. Claims have no timer expiry. Polling checks
pending controls in every local status, with an indexed bounded read and active
cadence. A route crash after claiming is covered by the same poll wakeup.

Only canonical reconciliation writes cancelAt (settled paidThrough when scheduled,
absent otherwise). Controls never change settled periods, lots, credits or recovery
markers. controlRenewable is an additive optional canonical provider-state bit;
old rows cannot uncancel until read. No migration/backfill is required. All added
schema fields are optional and existing rows remain valid.

## Pinned provider evidence

Published source, fetched without installing: `dodopayments@2.63.0`:

- [subscriptions.ts](https://unpkg.com/dodopayments@2.63.0/src/resources/subscriptions.ts)
  lines 55–75: GET/PATCH `/subscriptions/{subscriptionID}`; line 562: retrieve
  `cancel_at_next_billing_date: boolean`; line 1786: update optional boolean/null.
  We send literal true for period_end and false for resume, then freshly retrieve.
  Lines 1838–1852 explicitly document `status: "cancelled"` for immediate cancel;
  this timing is reserved for 10c, never accepted by user routes. `cancelled_at`
  (690) describes an already cancelled subscription, not scheduled period expiry.
- Subscription customer (580–582), product_id (634), status (650) and subscription_id
  (655) bind the retrieve. Subscription has no business_id, so the adapter checks
  [customers/customers.ts](https://unpkg.com/dodopayments@2.63.0/src/resources/customers/customers.ts)
  lines 198–203: Customer.business_id and customer_id via GET `/customers/{id}`
  both before dispatch and during fresh confirmation. Mode selects the fixed API host.
- [customers/customer-portal.ts](https://unpkg.com/dodopayments@2.63.0/src/resources/customers/customer-portal.ts)
  lines 20–29: POST `/customers/{id}/customer-portal/session`, `send_email` is a query
  parameter, not JSON; customers.ts 229–230 returns `{ link: string }`.
  Portal hosts and exposed actions are not proven by these types. Portal stays out
  of 10a; 10a2 must remain fail-closed pending the stage-13 host/action evidence.

Injected fetch, bounded response reads, manual redirects and a total 15-second
abort budget; no automatic write retry or provider URL/body/error logging. Unknown
writes remain unknown. SDK types do not establish scoped-key PATCH permissions,
production behavior, redirect handling or cancellation timing in a real account;
those remain stage-13 gates. No provider call was made to develop this change.

## Verification

CI on the exact pushed head is the gate. Local typecheck, lint, tests, build,
install, servers and deployment were prohibited. Added mocked adapter/routes,
pure rule and convex-test cases cover claims, ownership and settled-money safety.

## 10c deletion executor

`billingCancellation` runs independently of checkout enablement. A 15-minute sweep
selects at most five due obligations in the deployment mode. Each action makes at
most 20 sequential external requests, including the immediate adapter's nested
ownership GETs, PATCH and confirmation GETs. Every retry starts with a fresh read;
unknown user controls never replay an uncancel. No deploy or provider operation
was performed while implementing this executor.

The separate optional `cancellationLeaseId`/`cancellationLeaseExpiresAt` fields do
not change the receipt lease. Claims last ten minutes and fence commits by lease,
generation and input revision. Crashes consume an attempt; eight failures move
the obligation to indexed support. Backoff starts at 15 minutes, caps at one day,
and honors a longer Retry-After. A successful chunk resets the failure count.

`cancellationProgress` stores a fixed discovery window, phase, page, within-page
offset and local cursor; it never stores an unbounded resource list. Discovery
covers subscriptions since epoch, then every known local subscription, then
payments through the end of subscription cancellation, then every local purchase.
Full lists continue; the existing page cap requires support, never completion.
Findings use the existing synthetic-receipt queue. A new receipt invalidates the
proof and requires a fresh pass; it never creates a second grant path.

Completion requires exhausted discovery and local pages, ended owned subscriptions,
expired unpaid checkouts with fresh failure/no-payment evidence, no uncertain
creates, no unresolved receipts or checkout lock, and no processing/unmatched
charge. An unmatched succeeded charge remains review work; no refund occurs.
Periods, lots, entitlements, tombstones and financial dedupe are never shortened
or deleted here. Support may conservatively retain obligations even after a
provider condition changes; new evidence/operator recovery must wake them.

New evidence alone calls `queueDeletionRecovery`: reset attempts/outcome, mark due,
and increment input revision. Keep the live cancellation lease and old progress;
the next claim resets mismatched progress. Retention must additionally enforce all
its existing resource-marker, receipt, hold, watch and pending-control blockers,
require `cancellationRecoveryRequired === false` and outcome `complete`, and refuse
a live cancellation lease. All new schema fields are optional; no backfill/deploy
is included. Verification is exact-head CI only, per lane rules.
## Durable deletion obligations (10b)

The signed Clerk deletion path tombstones each mode's existing billing customer
in the same transaction as the user, sets a recovery obligation, and invalidates
in-flight reconciliation via generation/inputRevision. Resource markers are
paged in batches of 20 using existing customer index prefixes; a customer
obligation covers work before these pages finish. Financial rows survive
`purgeUserData`; retention is separate (10d).

Late customer/session/payment/subscription evidence is retained without granting
benefits. New evidence reopens recovery (including support/complete), resets its
attempt budget and advances inputRevision. Unchanged replays preserve the retry
state. This invalidates 10c's pinned evidence without releasing its live
cancellation lease, so opposing provider writes remain serialized. Duplicate
Clerk deletion preserves the first deletedAt and support/complete unless resource
markers reopen the obligation. Unknown creates remain pending for recovery or
support; deletion never creates a remote customer.

Credit charges can update existing usage rows after a tombstone, but cannot
insert missing per-user credit/spend rows. Site-wide model spend still records
incurred costs. Billing holds alone do not block charging. No deletion helper
shrinks paid periods, credit lots or refunds money. This PR records obligations;
10c executes provider cancellation. Billing enablement requires 10b–10d together.
