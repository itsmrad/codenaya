# 0007. Platform AI usage metered per user per month; per-plan caps enforced server-side

- Status: Accepted
- Date: 2026-10-23
- Related: ADR 0006, #105 (billing)

## Context

Codenaya's own key (the platform provider, ADR 0006) costs us money on every model
call, and nothing tracked or limited it. The owner wants a monthly spend and/or token
cap per plan, set in /admin, that blocks a user's platform AI once either cap is reached.
Billing (#105, Polar) doesn't exist yet, so no plan is stored per user. Agent runs are
Inngest functions that replay and retry, so a naive "add usage after each call" would
count calls twice.

## Decision

- **Ledger in Convex** (`convex/aiUsage.ts`): `aiUsageEvents` holds one row per model call
  with a deterministic `key` (`<inngestRunId>:t<turn>`, `:title`, `editor:<uuid>`), and
  `aiUsageMonthly` holds one aggregate per user per UTC month. `record` dedupes on `key`
  and bumps the aggregate in the same transaction, so a retried step never counts twice.
- **Money is integer micro-USD.** Prices are USD per 1M tokens, so `tokens × $/MTok`
  is exactly µUSD. The price is the saved price of the provider that ran (`platformModelConfigs`),
  else that provider's default model's price (over, not under), else a high fallback rate
  (`UNPRICED_FALLBACK_PRICE`, $15/$75 per 1M tokens) marked `priced: false`: unpriced usage
  is never free, so the USD caps keep working. Prices never travel in events.
- **Caps per plan** (`convex/planLimits.ts`, `planLimits` table): optional USD and token
  caps; no row means the `PLANS` default (monthly credits in USD, no token cap). Reaching
  either cap, exactly at the cap included, blocks.
- **One plan seam:** `userPlanId(ctx, userId)` returns `"free"` until #105 stores a plan;
  only its body changes then.
- **Enforcement, platform runs only** (BYOK is never checked or metered):
  - the send routes check inside the existing `getActiveForServer` read (`usageOf`), so
    the check adds no round trip; over a cap → 402 `{ code: "usage_limit" }`;
  - the run checks again in its first step (a queued run can start after the cap), and
    after each recorded model call stops before the next one;
  - editor AI checks in the same read and meters each call through a `wrapLanguageModel`
    middleware.

## Alternatives considered

- **Count from the events table.** Every check would scan a growing table; the monthly
  aggregate is one point read.
- **`@convex-dev/aggregate` or a rate-limiter component.** A per-user monthly sum is one
  document; a component adds a dependency for what a patch does.
- **Reserve an estimate before each call.** Exact, but needs a second write per call and
  a release path for failures. The overrun without it is one in-flight call.

## Consequences

- One mutation per model call; concurrent runs of a user contend on one document (at most
  two runs per user).
- A user can overshoot a cap by the call in flight (or the editor call that crossed it).
- `aiUsageEvents` grows by one row per call; add a batched retention cron at about 1M rows.
- #105 should build credits and Polar on this ledger rather than add a second one.
