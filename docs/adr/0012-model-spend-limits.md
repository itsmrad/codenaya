# 0012. Per-model spend limits in USD, per user and site-wide

- Status: Accepted
- Date: 2026-10-29
- Related: ADR 0010 (the priced catalog), ADR 0011 (credit metering), ADR 0009 (promo runs)

## Context

Billing isn't live, so the credit cap is off (`CREDIT_LIMITS_ENFORCED`) and nothing
bounds what a model costs. The admin needs to cap that spend per model in dollars,
for one user and for the whole site, over a period they pick, including promo models,
which cost the platform as much as any other run.

## Decision

- **The limit lives on the catalog model.** `spendLimit { perUserUsd?, totalUsd?,
  resets }` (`daily`, `weekly` from Monday, `monthly`, `never`; all UTC). At least one
  cap is set, each above $0 and at most $100,000. It's edited in the model's sheet in
  /admin and audited with the rest of the catalog.
- **Spend comes from the run's cost at the catalog price.** `credits.recordRunUsage`
  already gets each run's growing `costUsd` (ADR 0011). It adds the growth to two
  `modelSpend` rows for the run's model: the owner's and the site's (`userId: null`).
  A row from an earlier period counts as nothing spent, so periods reset lazily with no
  cron. Platform and promo runs count; a user's own key doesn't. Spend is only counted
  while the model has a limit.
- **Enforced at send.** `validateModelChoice` reads the model's two rows when it has a
  limit and refuses with `402` / `model_limit_reached` once either cap is reached, for
  promo models too, whatever `CREDIT_LIMITS_ENFORCED` says. As with credits, a run that
  starts under a cap may end past it, and the next send is refused.
- **Rules live in `src/features/billing/model-spend.ts`.** Convex functions are in
  `convex/modelSpend.ts`. A user's rows are purged with the account; the site's stay.

## Alternatives considered

- **Credits per model.** Credits are a per-user grant tied to plans. The admin wants
  dollars at the provider's price and a site-wide budget, which credits don't have.
- **Summing the ledger at send.** Exact, but the reads grow with every run. Counter
  rows are one read per cap.
- **OpenRouter's key spend limits.** One limit per API key, not per model or user.

## Consequences

- The site-wide row is written by every run on the model, so busy models see write
  contention. Shard the row if that shows up in Convex insights.
- A run's cost includes its title on the utility model, a small overcount on the
  coding model.
- Editor AI isn't metered (ADR 0011), so it's never limited, even on a limited model.
- Spend before a limit is saved isn't counted; a new limit starts from $0.
