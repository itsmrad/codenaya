/**
 * The GitHub launch promotion (ADR 0009): a GitHub account at least a year old
 * claims, once, 20 Claude Opus 5.5 runs and unlimited Claude Sonnet 5.5 until
 * the promotion ends.
 *
 * Pure on purpose: Convex enforces these numbers, the routes and the agent run
 * check them, and the page and picker render them from the same constants.
 * No imports from `ai-providers`, which depends on this module.
 */

/** Exclusive end: Nov 1 2026 00:00 UTC. Claims and promo runs stop here. */
export const PROMO_ENDS_AT = Date.UTC(2026, 10, 1);

/** The GitHub account must be at least this old when it claims. */
export const MIN_GITHUB_ACCOUNT_AGE_DAYS = 365;

/** Opus runs each claim includes. Sonnet runs are not counted. */
export const PROMO_OPUS_RUN_LIMIT = 20;

export const PROMO_PATH = "/promo";

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
  not_claimed: `Claim the free Claude promotion at ${PROMO_PATH} to use this model.`,
  ended: "The free Claude promotion has ended. Pick another model to continue.",
  opus_used_up: `You've used all ${PROMO_OPUS_RUN_LIMIT} free Opus 5.5 runs. Claude Sonnet 5.5 is still free until the promotion ends.`,
};

/** The `code` a send route answers when a promo model can't run. */
export const isPromoRefusalCode = (code: string | undefined) =>
  code !== undefined && code.startsWith("promo_");

/** Why `POST /api/promotions/claim` refused; the page branches on these. */
export type PromoClaimErrorCode =
  | "github_not_linked"
  | "github_unavailable"
  | "github_too_new"
  | "github_already_used"
  | "already_claimed"
  | "promo_ended";

export const PROMO_CLAIM_ERROR_MESSAGES: Record<PromoClaimErrorCode, string> = {
  github_not_linked: "Connect your GitHub account to claim.",
  github_unavailable: "Couldn't reach GitHub to check your account. Please try again.",
  github_too_new: `This promotion is for GitHub accounts at least ${MIN_GITHUB_ACCOUNT_AGE_DAYS} days old.`,
  github_already_used: "This GitHub account was already used to claim the promotion.",
  already_claimed: "You've already claimed the promotion.",
  promo_ended: "The promotion has ended.",
};

/** The end, as the page and banner say it: "Nov 1, 00:00 UTC". */
export const PROMO_ENDS_LABEL = `${new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
}).format(PROMO_ENDS_AT)} UTC`;
