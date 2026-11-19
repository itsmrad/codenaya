# 0016. Dodo collects payments; Convex owns credit access and spending

- Status: Proposed (approved architecture; implementation staged)
- Date: 2026-11-17
- Related: #105, ADR 0001, ADR 0011, ADR 0012
- Supersedes: only ADR 0011's UTC-calendar-month assumption for **paid** periods.
  ADR 0011 remains immutable; its cumulative usage meter and run ledger remain.

## Context

Pro and top-ups need payment collection, durable grants and reversals without
turning a payment redirect or a provider's balance into access authority. Existing
Free credit metering and model spend limits already live in Convex. This decision
records the approved billing contract; it does not enable payments.

## Decision

- **Authority.** Dodo collects money only. Convex remains the sole authority for
  access, grants, debt and spending; Dodo's native credit ledger is not used.
  Preserve the cumulative usage meter and inference/run ledger. Financial grant
  ledgers are separate, attributable to their settled payment and service period.
- **Products.** Monthly Pro costs $20 for 2,000 credits per paid service period,
  not a calendar month. Carry at most 2,000 unused paid-period credits once into
  the next paid period; carried credits cannot roll again. One top-up SKU costs
  $10 for 1,000 credits with a 12-month expiry. Cancellation is at period end;
  there is no provisional access or renewal grace before settled payment.
- **Free and debt.** Retained purchased lots remain usable on Free, under Free's
  default-model restriction and 60-credit daily cap. The 300-credit monthly Free
  allocation is consumed before purchased lots and offsets debt once per monthly
  allocation; replay cannot apply the offset twice.
- **Settlement.** Grant only from verified settled payment plus its service
  period, never a checkout return, client assertion or subscription status alone.
  Convex receives signed Standard Webhooks: validate the raw body, signed id and
  timestamp with bounded replay tolerance, then durably deduplicate the inbox.
  All webhook and reconciliation projections share the same receipt revision and
  account generation fence. Commit inbox handling and financial effects atomically;
  stale work cannot restore a revoked grant or a deleted account's access.
- **Reversals.** Refunds revoke the attributable unused grant; reversal of consumed
  credit becomes debt. A dispute freezes platform-funded access. Owned BYOK
  remains separate. Deletion preserves financial tombstones and cancellation
  obligations, including late checkout settlements; it must not orphan subscriptions
  or resurrect access. Exact retention periods await the legal launch gate.
- **Inference.** A fresh Convex revocation gate must run before every new
  platform-funded inference, including during an existing run. Preserve ADR 0012's
  spend limits and existing bounded concurrent overrun. This is not a hard prepaid
  spending guarantee; no inference ledger or native AI gateway migration is included.

### Stage 1 server configuration

`src/features/billing/server/dodo-config.ts` is pure TypeScript for server consumers.
It reads environment values at each call, never at import/build time. Callers pass
the trusted deployment explicitly (`development`, `preview`, `staging`,
`production`); `NODE_ENV` alone is insufficient. Never derive it from request input.

| Consumer | Required configuration | Optional configuration |
| --- | --- | --- |
| Both | `DODO_PAYMENTS_ENVIRONMENT`, `DODO_PAYMENTS_BUSINESS_ID` | None |
| Next | `DODO_PAYMENTS_API_KEY`, `DODO_PAYMENTS_PRO_PRODUCT_ID`, `DODO_PAYMENTS_RETURN_URL`, `NEXT_PUBLIC_APP_URL` | `DODO_PAYMENTS_BRAND_ID` |
| Convex receiver | `DODO_PAYMENTS_WEBHOOK_KEY` | `DODO_PAYMENTS_WEBHOOK_KEY_PREVIOUS` |

`CODENAYA_BILLING_ENABLED` defaults to disabled unless exactly `true`; disabled
Next config returns null. Enabling it also requires `CREDIT_LIMITS_ENFORCED=true`.
`CODENAYA_BILLING_TOP_UPS_ENABLED=true` additionally requires
`DODO_PAYMENTS_TOP_UP_PRODUCT_ID`. Missing, blank and `PLACEHOLDER_*` values are
absent, so placeholders can never enable a configured consumer. Optional placeholders
are absent too. Receiver config stays available while checkout is disabled so
refunds, disputes and cancellations can still be processed.

Production requires exact `live_mode`, trusted `NEXT_PUBLIC_APP_URL=https://codena.tech`
and `DODO_PAYMENTS_RETURN_URL=https://codena.tech/settings/billing/return`.
Development, preview and staging require exact `test_mode` and an isolated trusted
origin outside `codena.tech` and its subdomains. Nonlocal test origins require HTTPS;
HTTP is permitted only on localhost or loopback. The return URL must match that
origin and the fixed `/settings/billing/return` path exactly, without credentials,
query or fragment. The return UI is a later stage; its URL is not proof of payment.

Choose the future SDK's standard endpoint solely from the validated mode; no base
URL override is allowed (`DODO_PAYMENTS_BASE_URL` and
`DODO_PAYMENTS_API_BASE_URL` are rejected). Next neither requires nor receives
receiver signing keys. The receiver neither requires nor receives the API key.
Neither config nor SDK errors may be logged or serialized into client responses;
config errors contain fixed text and variable names only. Dodo secrets must never
use public environment variables. `NEXT_PUBLIC_APP_URL` is a trusted origin, not a
secret. Keep the existing matching `CODENAYA_CONVEX_INTERNAL_KEY` server bridge;
do not introduce a second bridge key.

## Alternatives considered

- **Dodo credit balances as authority.** Rejected: would split access and spending
  decisions from Convex and change existing metering semantics.
- **Rewrite existing usage rows into balances.** Rejected: use additive optional
  schema later, with separate grants and no old-row rewrite.
- **Grant on redirect or provisionally during renewal.** Rejected: neither proves
  settlement and both complicate revocation and duplicate delivery.

## Consequences

- Stage 1 adds only the server config contract, pure unit matrix and this ADR:
  no SDK, network calls, routes, schema, environment writes or deployments.
- Later stages must implement and adversarially test settlement, concurrent
  revisions, deletion, refunds, disputes, expiry and inference revocation.
- Live launch stays gated on exact retention/legal policy, India merchant approval,
  credit enforcement and implementation verification. The exact AI gateway user
  link is unresolved; native gateway and ledger migration remain deferred.

Public protocol references: [Dodo integration guide](https://docs.dodopayments.com/developer-resources/integration-guide),
[Dodo webhooks](https://docs.dodopayments.com/developer-resources/webhooks),
[Standard Webhooks specification](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md).
Product and access policies above are Codenaya decisions, not provider guarantees.
