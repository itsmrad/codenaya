# 0009. GitHub promotion: verified claims and a per-claim Opus run count

- Status: Accepted
- Date: 2026-10-28
- Related: ADR 0006 (the platform selection this adds to)

## Context

Until Nov 1 2026 00:00 UTC, developers whose GitHub account is at least a year
old get 20 Claude Opus 5.5 runs and unlimited Claude Sonnet 5.5 for free. The
platform has no credit metering yet (`features/billing/plans.ts` only feeds
/pricing), and the admin's selection (ADR 0006) decides which platform models
everyone may pick. The offer has to resist throwaway accounts and survive
parallel sends and an event-key holder naming any model.

## Decision

- **The rules are one pure module**, `features/promotions/github-promo.ts`: the
  end, the minimum account age, the Opus limit, and the promo model ids per
  provider (OpenRouter and Anthropic; Groq and OpenAI don't serve Claude).
  Convex, the routes, the run and the UI all read it.
- **A claim is verified with GitHub, not the client.** `POST
  /api/promotions/claim` takes the user's GitHub token from Clerk and reads
  `created_at` from `GET api.github.com/user`. `promoClaims` (`convex/promoClaims.ts`)
  allows one claim per user and one per GitHub account, so a GitHub account
  linked to several Codenaya users claims once.
- **Promo models are added on top of the selection, only for claimants.**
  `promoOnlyModels` lists the promo models the selection lacks; a model the
  admin already offers everyone needs no claim and uses no run.
- **The send checks, then takes the run once it is known to go.**
  `validateModelChoice` only reads the claim (`promoClaims.getForServer`) and
  refuses early, and returns the promo kind it validated. After the route's
  ownership checks and before it creates anything, `takePromoRun` calls
  `promoClaims.takeRun` with that kind, which checks the claim and the end
  and, for Opus, counts the run in the same transaction, so two sends can't
  both take the last run. A send that fails before its agent run starts
  (a thrown error or a failed dispatch) gets the run back (`refundRun`), so
  retrying from the chat costs one run. A refusal is a
  403 with `code: promo_*` and a message, not a silent fallback to another
  model, which would surprise someone who picked Opus.
- **The run re-checks the claim, not the count or the clock.**
  `resolveRunModel` asks `promoClaims.hasClaimForProjectOwner`; the send
  already counted the run, and a run queued just before the end still goes.
- **Queries never read the clock** (Convex guideline). `getMine` returns the
  claim; the page, banner and picker decide "active" in the browser, and the
  mutations and routes decide it on the server.

## Alternatives considered

- **Credits (Pro's 2,000) with token metering.** Needs usage parsing and prices
  for every model; a run count is what the owner wants to give and is exact.
- **Checking age from Clerk's external account.** Clerk has no GitHub creation
  date; only GitHub's API does.
- **A general entitlements/plans table.** Speculative until billing exists; the
  claim table is small and can be dropped after the promotion.

## Consequences

- Each promo send does one extra read and one mutation; each promo run one
  query. Other sends do nothing extra.
- If the refund itself fails (Convex unreachable), it is logged and the run
  stays used. Only the caller's own runs are at stake.
- The picker drops Opus once its runs are used, so a stored Opus choice
  falls back to the user's default instead of being refused on every send.
- Sonnet is uncapped until the end, so its cost is open-ended for that window.
- After the promotion, delete `features/promotions`, `promoClaims` and the
  `promoOnlyModels` hooks in `resolve-run-model.ts`, the picker and the banner.
