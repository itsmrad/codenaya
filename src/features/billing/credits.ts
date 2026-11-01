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
  inputTokens: number;
  outputTokens: number;
}

const NO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

const tokens = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * Tokens one inference used, from AgentKit's raw provider response: OpenAI
 * chat (`prompt_tokens`) or Anthropic (`input_tokens`, plus any cache reads
 * and writes, which Anthropic counts apart). Zero when the response has none.
 */
export function usageOfResponse(raw: string | undefined): TokenUsage {
  let usage: Record<string, unknown> | undefined;
  try {
    usage = JSON.parse(raw ?? "{}")?.usage;
  } catch {
    return NO_USAGE;
  }
  if (!usage || typeof usage !== "object") return NO_USAGE;
  if ("prompt_tokens" in usage || "completion_tokens" in usage) {
    return { inputTokens: tokens(usage.prompt_tokens), outputTokens: tokens(usage.completion_tokens) };
  }
  return {
    inputTokens:
      tokens(usage.input_tokens) +
      tokens(usage.cache_creation_input_tokens) +
      tokens(usage.cache_read_input_tokens),
    outputTokens: tokens(usage.output_tokens),
  };
}

/** The provider's cost in USD for `usage` at a catalog route's price. */
export const costUsd = (pricing: ModelPricing, { inputTokens, outputTokens }: TokenUsage) =>
  pricing.mode === "blended"
    ? ((inputTokens + outputTokens) * pricing.usdPerMTok) / 1e6
    : (inputTokens * pricing.inputUsdPerMTok + outputTokens * pricing.outputUsdPerMTok) / 1e6;

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

export function creditRefusal(
  plan: Plan,
  usage: CreditUsage | null,
  now: number,
): CreditRefusal | null {
  const { monthLeft, dayLeft } = creditStanding(plan, usage, now);
  if (monthLeft === 0) return "month_used_up";
  if (dayLeft === 0) return "day_used_up";
  return null;
}

/** The send routes' answer, with `code: "insufficient_credits"`. */
export const CREDIT_REFUSAL_MESSAGES: Record<CreditRefusal, string> = {
  month_used_up:
    "You've used this month's free credits. Add your own key in Settings → AI providers for unlimited runs.",
  day_used_up:
    "You've used today's free credits. They reset at midnight UTC, or add your own key in Settings → AI providers for unlimited runs.",
};

export const INSUFFICIENT_CREDITS_CODE = "insufficient_credits";
