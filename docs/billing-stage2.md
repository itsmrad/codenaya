# Billing identity and receipt storage (stage 2)

Implements ADR 0016's storage boundary. Existing users, credits and usage rows
are unchanged. Four new tables are additive; no backfill or migration is needed.
No grants, adjustments, SDK, HTTP routes, checkout calls or schedulers are added.

`convex/billing.ts` exposes only internal mutations and an internal fence query.
`ensureCustomer` receives trusted, verified Clerk `tokenIdentifier` and subject;
browser input must never supply these; the token must end in `|<subject>`.
Subject remains the existing credit key. An active mirrored user is required for
customer creation, provider-customer binding that readies the customer, and
purchases. No email lookup participates in binding. Mode scopes every provider-ID
lookup; receipt and binding callers pass mode explicitly and it must match the row.
An indexed check and its insert/binding occur in the same Convex transaction;
indexes alone do not enforce uniqueness.

The customer is the shared coordinator for all its subscriptions and purchases:
`customerRef` is their chain reference. Generation, lease and input revision live
there rather than in separate, divergent per-subscription coordinators.
Customer creation starts `preparing`; an uncertain provider outcome must become
`unknown`, never authorize a second customer creation. A pending purchase reference
is a durable checkout lock; expiry or an unknown outcome cannot release it.
Intent replay must match the original immutable catalog terms. Session/payment
IDs cannot change or move between purchases. Subscription bindings cannot move
between customers or products. Late customer, purchase and subscription IDs are
recorded on deleted or held owners for recovery, without reopening the customer or
purchase or granting access; purchases and subscriptions bound to a deleted owner
are marked `cancellationRecoveryRequired`. An ID still never maps to two owners per mode.

Receipts contain normalized identifiers, event type/time and a SHA-256 body digest,
never raw payloads or payment credentials. A verified receipt whose customer is not
yet mapped is still stored, with its explicit mode, as `quarantined` and without a
parent, so it deduplicates and is never discarded; it advances no customer revision.
The child subscription/payment need not yet be known. Each new mapped receipt
increments the parent's revision and unresolved count. Same mode/ID/digest is a no-op;
changed proof quarantines the original entry, preserving its digest and resources,
and invalidates its original parent's revision once. Late receipts still dirty
deleted parents. These tables are intentionally outside the ordinary usage purge.

Future processing must resolve receipts and decrement their unresolved count in
the same transaction as their financial effects. Every positive financial commit
must call `assertBillingFence` inside that mutation, comparing captured generation
and revision and refusing unresolved receipts, deleted/absent owners or holds.
Stage 2 cannot clear receipts, release checkout locks or alter financial state.
Deletion generation/hold hooks, reconciliation, receipt resolution and explicit
quarantine recovery belong to later stages.

`convex/billing.test.ts` exercises repeated duplicate delivery, proof collisions,
mode isolation, immutable bindings, checkout locks, deletion, fences and old rows.
Tests run against installed Convex/convex-test types with synthetic values only;
cloud schema validation remains for the lead's later development deployment.
