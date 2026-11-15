import type { Infer } from "convex/values";

import type { runSourceValidator } from "../../../convex/schema";
import type { ModelPricing } from "../ai-providers/catalog";
import { CREDIT_VALUE_USD, type Plan } from "./plans";

/**
 * Credit metering for platform runs (ADR 0011). Pure on purpose: Convex
 * charges with these rules, the send routes check them, and the UI renders
 * the same numbers.
 */

/** Credits charge the provider's cost times this (#105). */
export const CREDIT_MARKUP = 1.5;

/** Who pays for a run. Only "platform" runs cost credits. */
export type RunSource = Infer<typeof runSourceValidator>;

export interface TokenUsage {
  /** All input tokens, cache reads and writes included. */
  inputTokens: number;
  outputTokens: number;
  /** The part of `inputTokens` read from the prompt cache. */
  cacheReadTokens?: number;
  /** The part of `inputTokens` written to the prompt cache. */
  cacheWriteTokens?: number;
}

/**
 * Prompt-cache prices against the input price: a read costs 0.1x, a write with
 * the default 5-minute TTL 1.25x (Claude's rates; we set no 1-hour TTL).
 */
export const CACHE_READ_PRICE_RATIO = 0.1;
export const CACHE_WRITE_PRICE_RATIO = 1.25;

const NO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

const tokens = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Tokens one inference used, from AgentKit's raw provider response: OpenAI
 * chat (`prompt_tokens`, cache tokens included) or Anthropic (`input_tokens`,
 * with cache reads and writes counted apart). Zero when the response has none.
 * shortcut: OpenAI-format cache tokens count only for Claude (via OpenRouter);
 * other models' cache rates vary, so their cached input stays at full price.
 */
export function usageOfResponse(raw: string | undefined): TokenUsage {
  let response: unknown;
  try {
    response = JSON.parse(raw ?? "{}");
  } catch {
    return NO_USAGE;
  }
  const usage = record(response) ? response.usage : undefined;
  if (!record(usage)) return NO_USAGE;
  if ("prompt_tokens" in usage || "completion_tokens" in usage) {
    const details = record(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
    const claude = record(response) && typeof response.model === "string" && /claude|anthropic\//i.test(response.model);
    const inputTokens = tokens(usage.prompt_tokens);
    const cacheReadTokens = claude ? Math.min(inputTokens, tokens(details.cached_tokens)) : 0;
    const cacheWriteTokens = claude ? Math.min(inputTokens - cacheReadTokens, tokens(details.cache_write_tokens)) : 0;
    return { inputTokens, outputTokens: tokens(usage.completion_tokens), cacheReadTokens, cacheWriteTokens };
  }
  const cacheReadTokens = tokens(usage.cache_read_input_tokens);
  const cacheWriteTokens = tokens(usage.cache_creation_input_tokens);
  return {
    inputTokens: tokens(usage.input_tokens) + cacheReadTokens + cacheWriteTokens,
    outputTokens: tokens(usage.output_tokens),
    cacheReadTokens,
    cacheWriteTokens,
  };
}

/**
 * Input tokens weighted by what they cost: uncached at 1x, cache reads and
 * writes at their ratios.
 */
const pricedInputTokens = ({ inputTokens, cacheReadTokens = 0, cacheWriteTokens = 0 }: TokenUsage) =>
  inputTokens - cacheReadTokens - cacheWriteTokens +
  cacheReadTokens * CACHE_READ_PRICE_RATIO +
  cacheWriteTokens * CACHE_WRITE_PRICE_RATIO;

/** The provider's cost in USD for `usage` at a catalog route's price. */
export const costUsd = (pricing: ModelPricing, usage: TokenUsage) =>
  pricing.mode === "blended"
    ? ((pricedInputTokens(usage) + usage.outputTokens) * pricing.usdPerMTok) / 1e6
    : (pricedInputTokens(usage) * pricing.inputUsdPerMTok + usage.outputTokens * pricing.outputUsdPerMTok) / 1e6;

/** Credits for a run's total cost, rounded up so a paid run is never free. */
export const creditsForCost = (usd: number) =>
  // toFixed first: 0.1 * 1.5 / 0.01 is 15.000000000000002, which must stay 15.
  Math.ceil(Number(((usd * CREDIT_MARKUP) / CREDIT_VALUE_USD).toFixed(6)));

/** Credits used in the current month and UTC day. */
export interface CreditUsage {
  periodStartsAt: number;
  periodUsed: number;
  dayStartsAt: number;
  dayUsed: number;
}

const startOfMonth = (now: number) => {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
};

const startOfDay = (now: number) => {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `usage` as of `now`: a month or day that has ended counts as unused. Grants
 * reset lazily, on the next read or charge, so there is no reset cron.
 */
export function currentUsage(usage: CreditUsage | null, now: number): CreditUsage {
  const periodStartsAt = startOfMonth(now);
  const dayStartsAt = startOfDay(now);
  return {
    periodStartsAt,
    periodUsed: usage?.periodStartsAt === periodStartsAt ? usage.periodUsed : 0,
    dayStartsAt,
    dayUsed: usage?.dayStartsAt === dayStartsAt ? usage.dayUsed : 0,
  };
}

export interface CreditStanding {
  monthLeft: number;
  /** Null when the plan has no daily cap. */
  dayLeft: number | null;
  /** What the user can spend now: the smaller of the two. */
  left: number;
  monthResetsAt: number;
  dayResetsAt: number;
}

/** What `plan` leaves the user at `now`. A run can overshoot, so never below 0. */
export function creditStanding(plan: Plan, usage: CreditUsage | null, now: number): CreditStanding {
  const current = currentUsage(usage, now);
  const monthLeft = Math.max(0, plan.monthlyCredits - current.periodUsed);
  const dayLeft =
    plan.dailyCreditCap === null ? null : Math.max(0, plan.dailyCreditCap - current.dayUsed);
  const nextMonth = new Date(current.periodStartsAt);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  return {
    monthLeft,
    dayLeft,
    left: Math.min(monthLeft, dayLeft ?? monthLeft),
    monthResetsAt: nextMonth.getTime(),
    dayResetsAt: current.dayStartsAt + DAY_MS,
  };
}

/** Why a platform run can't start: the month's grant or today's cap is spent. */
export type CreditRefusal = "month_used_up" | "day_used_up";

/**
 * Roughly one agent step: the system prompt and project context in, a reply
 * out (#643; a 13-step build averaged ~26k in, ~1.4k out per step).
 */
export const MIN_RUN_USAGE: TokenUsage = { inputTokens: 30_000, outputTokens: 2_000 };

/** Credits a platform run needs to start: one step at `pricing`, else 1. */
export const minRunCredits = (pricing: ModelPricing | undefined) =>
  Math.max(1, pricing ? creditsForCost(costUsd(pricing, MIN_RUN_USAGE)) : 1);

/** Refuses when the month or today has fewer than `minCredits` left (#643). */
export function creditRefusal(
  plan: Plan,
  usage: CreditUsage | null,
  now: number,
  minCredits = 1,
): CreditRefusal | null {
  const { monthLeft, dayLeft } = creditStanding(plan, usage, now);
  if (monthLeft < minCredits) return "month_used_up";
  if (dayLeft !== null && dayLeft < minCredits) return "day_used_up";
  return null;
}

/** The send routes' answer, with `code: "insufficient_credits"`. */
export const CREDIT_REFUSAL_MESSAGES: Record<CreditRefusal, string> = {
  month_used_up:
    "You don't have enough of this month's free credits left for this model. Pick a cheaper model, or add your own key in Settings → AI providers for unlimited runs.",
  day_used_up:
    "You don't have enough of today's free credits left for this model. They reset at midnight UTC, or pick a cheaper model or add your own key in Settings → AI providers for unlimited runs.",
};

export const INSUFFICIENT_CREDITS_CODE = "insufficient_credits";
