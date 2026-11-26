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

Authorization follows the existing feature-local billingCheckout convention:
validateInternalKey first, then verifyAuth and both ownerTokenIdentifier/subject
checks against the resource's customer. The small domain helper is intentionally
local; broad admin/auth consolidation would change unrelated trust boundaries.
Same-origin and JSON guards are the identical established shared request helpers.

## Stage 10a2: owned portal (disabled pending verification)

`POST /api/billing/portal` accepts only empty JSON, with the existing same-origin,
Clerk, rate-limit and authenticated Convex bridge guards. `prepareControl` selects
only the live caller's bound customer using both token identifier and subject.
Portal access requires no active subscription and remains available on holds and
with checkout disabled; deleted/unbound owners are refused. It makes no local
billing writes, refunds, grants or changes to settled access/recovery obligations.

The adapter implements the pinned 2.63.0 contract directly using the existing
injected fetch convention (no SDK dependency):
[customer-portal.ts](https://unpkg.com/dodopayments@2.63.0/src/resources/customers/customer-portal.ts)
lines 20–29 send POST `/customers/{id}/customer-portal/session` with query
`send_email=false`, no return URL; `CustomerPortalSession.link` is the response.
It refuses redirects, bounds response bytes and time, and sanitizes all failures.
Only the owned validated HTTPS URL is returned, with `no-store`; never log or
persist it. Every route response, including refusals, is `no-store`.

Both `DODO_PORTAL_HOSTS` mode lists intentionally remain empty: requests return
`503 { code: "portal_unavailable" }` before any provider call. Static login
hosts do not prove API session-link hosts. Stage 13 must prove the exact host
separately in each mode and check merchant actions (period-end-only cancellation;
plan changes, pause and retention offers off) before a reviewed list change.
Immediate/next-cycle cancellation settings are independent; documentation is not
merchant configuration evidence. Any provider-side cancellation still preserves
settled paidThrough/lots; refunds and disputes remain in the reversal path.
