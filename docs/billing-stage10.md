# Stage 10a: owned cancellation controls

Cancel schedules the end of renewal; uncancel only removes that schedule while a
settled period remains unexpired and the canonical provider state is active. Holds
block uncancel, but never cancellation. The server chooses the owned active
subscription; requests carry no IDs or timing. Management ignores checkout flags.

Claims serialize opposing operations. Definite refusals release them; confirmed
and ambiguous writes stay pending through a persisted 60-second dispatch window
(`controlWriteUntil`, matching both routes' maxDuration). Canonical reconciliation
clears only on a read started strictly after both this deadline and any recorded
result time (`controlResultAt`). Before-result reads cannot release the write lock.
The trusted deadline is returned by prepareControl and passed only in server config;
the adapter refuses at entry and immediately before PATCH if expired and aborts at
the smaller of its 15-second timeout or remaining window. Missing deadline preserves
the deletion executor's separate adapter contract. Old claims without the optional
window use claim time + 60 seconds. Claims have no unconditional timer release. Polling checks
pending controls in every local status, with an indexed bounded read and active
cadence. Pending findings emit claim/read-specific receipt IDs, including repeated
active provider status, so every fresh recovery read can reach reconciliation.
Reread IDs are deduplicated before applying the resource limit. A route crash after
claiming or lost result is covered by the same post-window poll wakeup.

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
those remain stage-13 gates. A client abort/deadline prevents late dispatch but
cannot prove that an already accepted provider write will not execute later. The
window is an approved operational bound, not provider transaction fencing; late
completion behavior needs stage-13 verification and support handling. No provider call was made to develop this change.

## Verification

CI on the exact pushed head is the gate. Local typecheck, lint, tests, build,
install, servers and deployment were prohibited. Added mocked adapter/routes,
pure rule and convex-test cases cover claims, ownership and settled-money safety.

## Durable deletion obligations (10b)

The signed Clerk deletion path tombstones each mode's existing billing customer
in the same transaction as the user, sets a recovery obligation, and invalidates
in-flight reconciliation via generation/inputRevision. Resource markers are
paged in batches of 20 using existing customer index prefixes; a customer
obligation covers work before these pages finish. Financial rows survive
`purgeUserData`; retention is separate (10d).

Late customer/session/payment/subscription evidence is retained without granting
benefits. New evidence reopens recovery (including support/complete), resets its
attempt budget and advances inputRevision. Bindings compare stored IDs, payment
application compares its stored state, and ended subscription facts do not reopen
recovery. A renewable subscription fact still requires recovery if its marker was
cleared; it is fresh evidence that stopping future charges is not yet proven. This invalidates 10c's pinned evidence without releasing its live
cancellation lease, so opposing provider writes remain serialized. Duplicate
Clerk deletion preserves the first deletedAt and support/complete unless resource
markers reopen the obligation. Unknown creates remain pending for recovery or
support; deletion never creates a remote customer.

Credit charges can update existing usage rows after a tombstone, but cannot
insert missing per-user credit/spend rows. Site-wide model spend still records
incurred costs. Billing holds alone do not block charging. No deletion helper
shrinks paid periods, credit lots or refunds money. This PR records obligations;
10c executes provider cancellation. Billing enablement requires 10b–10d together.
Authorization follows the existing feature-local billingCheckout convention:
validateInternalKey first, then verifyAuth and both ownerTokenIdentifier/subject
checks against the resource's customer. The small domain helper is intentionally
local; broad admin/auth consolidation would change unrelated trust boundaries.
Same-origin and JSON guards are the identical established shared request helpers.

### Recovery completion contract (10b → 10c)

Before clearing a resource marker, 10c MUST persist the confirmed local terminal
purchase state or ended subscription status in that same fenced transaction.
It MUST NOT complete while a purchase is processing/open/unknown or a subscription
is renewable, or while a control claim can still dispatch. Discovery must retain
all resource IDs. This lets duplicate deletion batches and canonical ended-state
replays preserve completion instead of cycling complete → pending. Duplicate
Clerk deliveries do not advance generation/inputRevision; new resource evidence
advances only inputRevision and never releases a live receipt/recovery lease.
Missing mirrored users fail closed for new per-user usage rows and emit a short
warning without identifiers; existing usage rows remain chargeable.
