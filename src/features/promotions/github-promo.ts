/**
 * The GitHub launch promotion (ADR 0009): a GitHub account at least a year old
 * claims, once, 20 Claude Opus 5.5 runs and unlimited Claude Sonnet 5.5 until
 * the promotion ends.
 *
 * Pure on purpose: Convex enforces these numbers, the routes and the agent run
 * check them. The promotion ended, so the site no longer offers it; admins
 * still mark promo models in /admin.
 * No imports from `ai-providers`, which depends on this module.
 */

/** Exclusive end: Nov 1 2026 00:00 UTC. Claims and promo runs stop here. */
export const PROMO_ENDS_AT = Date.UTC(2026, 10, 1);

/** The GitHub account must be at least this old when it claims. */
export const MIN_GITHUB_ACCOUNT_AGE_DAYS = 365;

/** Opus runs each claim includes. Sonnet runs are not counted. */
export const PROMO_OPUS_RUN_LIMIT = 20;

/**
 * The run a promo model takes: "opus" counts against the claim's runs,
 * "sonnet" doesn't. Which models are promo models is the platform catalog's
 * `access` (ADR 0010).
 */
export type PromoModelKind = "opus" | "sonnet";

export const isPromoActive = (now: number) => now < PROMO_ENDS_AT;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether a GitHub account created at `createdAt` is old enough at `now`. */
export const isGithubAccountOldEnough = (createdAt: number, now: number) =>
  now - createdAt >= MIN_GITHUB_ACCOUNT_AGE_DAYS * DAY_MS;

/** A claim as the promotion reads it. */
export interface PromoClaimState {
  opusRunsUsed: number;
}

export const opusRunsLeft = (claim: PromoClaimState) =>
  Math.max(0, PROMO_OPUS_RUN_LIMIT - claim.opusRunsUsed);

/**
 * Why a claimant can't run `model` now, or null when they can. A missing claim
 * is the caller's case to word: the picker never lists promo models without one.
 */
export type PromoRunRefusal = "ended" | "opus_used_up";

export const promoRunRefusal = (
  claim: PromoClaimState,
  model: { kind: PromoModelKind },
  now: number,
): PromoRunRefusal | null => {
  if (!isPromoActive(now)) return "ended";
  if (model.kind === "opus" && opusRunsLeft(claim) === 0) return "opus_used_up";
  return null;
};

export const PROMO_REFUSAL_MESSAGES: Record<PromoRunRefusal | "not_claimed", string> = {
  not_claimed: "This model is only offered in a promotion. Pick another model to continue.",
  ended: "The free Claude promotion has ended. Pick another model to continue.",
  opus_used_up: `You've used all ${PROMO_OPUS_RUN_LIMIT} free Opus 5.5 runs. Claude Sonnet 5.5 is still free until the promotion ends.`,
};

/** The `code` a send route answers when a promo model can't run. */
export const isPromoRefusalCode = (code: string | undefined) =>
  code !== undefined && code.startsWith("promo_");
