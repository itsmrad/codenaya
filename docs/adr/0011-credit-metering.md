# 0011. Credit metering: usage-based accounts, a per-run ledger, priced by the catalog

- Status: Accepted
- Date: 2026-10-29
- Related: #105 (credits and billing), ADR 0010 (the priced catalog), ADR 0009 (promo runs)

## Context

The pricing page promises Free users 300 credits a month with a 60-credit daily cap
(`src/features/billing/plans.ts`), but nothing counted or enforced them: platform runs
were unmetered, so any account could spend the platform keys without limit. #105 fixes
the numbers (1 credit = $0.01; credits = provider cost × 1.5) and the eventual Polar
billing. This ADR covers metering and enforcement only. Payments come later.

Constraints:
- ADR 0010 already gives each platform route a price (provider cost per 1M tokens), so a
  run's cost follows from its tokens.
- Agent runs are Inngest functions that replay. A run can be cancelled (`cancelOn`) or
  fail mid-way, and neither path reaches the end of the function.
- Queries can't read the clock, and the send path has one Convex round-trip budget.

## Decision

- **Accounts store usage, not a balance.** `creditAccounts` (one per user,
  `by_userId`) holds `plan`, `periodStartsAt`/`periodUsed` (UTC calendar month) and
  `dayStartsAt`/`dayUsed` (UTC day). There's no row until the first metered run. A
  period that has ended counts as unused (`currentUsage`), so grants reset lazily, with
  no cron. What's left is `plan grant − used` (`creditStanding`). Top-ups (#105) add a
  field rather than change this shape.
- **One ledger row per run.** `creditLedger` (`by_messageId`, `by_userId`) holds the
  run's running `inputTokens`, `outputTokens`, `costUsd` and the `credits` charged. BYOK
  and promo runs are recorded at 0 credits, for usage history.
- **Charges set totals, they don't add.** `process-message` keeps the run's running
  totals in memory, rebuilt from memoized inferences on every replay, and after each
  inference (the title included) a `record-usage-N` step sends them to
  `credits.recordRunUsage`. The mutation ignores totals that didn't grow and charges
  the account only `creditsForCost(total) − credits already charged`. A retried or
  replayed step is a no-op, and a failed one is caught up by the next, or by the
  `record-usage-final` step at the end of a finished run. A cancelled or failed run
  is charged for what it used. A failure to record is logged and never
  fails the run. The owner comes from the message's project, not from the caller.
- **Cost is the catalog price.** `costUsd(route pricing, tokens)` for the coding model and
  the utility (title) model. `RunModel.metering` carries `source` and both prices. The
  env's curated catalog has no prices, so its runs record tokens at $0 until the admin
  saves a catalog. Token counts come from the provider's raw response
  (`usageOfResponse`: OpenAI chat or Anthropic shape).
- **Enforced at send.** `validateModelChoice` reads the account in parallel with the
  catalog. A platform model that isn't a promo model is refused with `402` /
  `insufficient_credits` when the month or the day has nothing left, but only when
  `CREDIT_LIMITS_ENFORCED=true`: until billing is live the cap is off and usage is
  only recorded. Promo models
  (ADR 0009) and BYOK keys are never credit-checked. A run that starts with credits left
  may finish past zero; the next send is refused. The agent run doesn't re-check
  credits: the send is the gate, and an overshoot is bounded by the per-owner
  concurrency of 2.
- **Rules live in `src/features/billing/credits.ts`** (pure, unit-tested). Convex
  functions are in `convex/credits.ts`. Both tables are purged with the account
  (`users.purgeUserData`).

## Alternatives considered

- **Store a balance and decrement it.** Simple to read, but a monthly grant, a daily cap
  and later top-ups all need resets or a cron, and a missed reset is a billing bug. Usage
  plus lazy reset needs no scheduler.
- **Charge once at the end of the run.** Cancelled and failed runs never reach the end, so
  they would be free. Charging per inference with set-semantics covers them.
- **One ledger row per inference, idempotent by step id.** Exact, but the usage view would
  have to aggregate dozens of rows per run, and the table grows far faster.
- **OpenRouter's `usage.cost`.** Exact for OpenRouter, but absent on the Anthropic, OpenAI
  and Groq routes ADR 0010 added, and different from the price the admin set.
- **The `@convex-dev/rate-limiter` component.** It's built for N-per-window counts. Credits
  are a weighted spend known only after the run, with a monthly and a daily window over
  the same counter.

## Consequences

- Free accounts can't spend past their grant by more than one run per concurrent slot.
- Editor AI (autocomplete, quick edit, prompt enhance) stays unmetered and is only
  rate-limited. Meter it if its spend matters.
- Pro has no way to be bought yet: `plan` is always "free" until Polar (#105) sets it.
- Revisit for top-ups and Pro rollover (#105), or if per-inference writes on the run path
  become a cost.
