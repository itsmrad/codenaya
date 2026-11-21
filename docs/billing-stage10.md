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
