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

export type RunTaskKind = "plan" | "build" | "edit" | "fix" | "vision" | "chat";

/** Typical minimum-viable token footprint per run kind for pre-run affordability checks (#643). */
export const RUN_TASK_TOKEN_ESTIMATE: Record<RunTaskKind, TokenUsage> = {
  build: { inputTokens: 30_000, outputTokens: 8_000 },
  vision: { inputTokens: 30_000, outputTokens: 8_000 },
  fix: { inputTokens: 20_000, outputTokens: 5_000 },
  edit: { inputTokens: 15_000, outputTokens: 3_000 },
  plan: { inputTokens: 8_000, outputTokens: 2_000 },
  chat: { inputTokens: 4_000, outputTokens: 1_000 },
};

const SPLIT = (inputUsdPerMTok: number, outputUsdPerMTok: number): ModelPricing => ({
  mode: "split",
  inputUsdPerMTok,
  outputUsdPerMTok,
});

const MODEL_PRICE_TIERS: readonly [string, ModelPricing][] = [
  ["claude-opus", SPLIT(5, 25)],
  ["claude-sonnet", SPLIT(3, 15)],
  ["claude-fable", SPLIT(2, 10)],
  ["claude-haiku", SPLIT(1, 5)],
  ["gpt-6.1-sol", SPLIT(2, 10)],
  ["gpt-6-luna", SPLIT(1.5, 8)],
  ["gpt-5.6-sol", SPLIT(2, 10)],
  ["gpt-5.6-luna", SPLIT(2.5, 15)],
  ["gpt-5.4-mini", SPLIT(0.3, 1.2)],
  ["gemini-3.1-pro", SPLIT(2, 12)],
  ["gemini-3.8-flash", SPLIT(0.2, 0.8)],
  ["grok", SPLIT(0.2, 0.5)],
  ["deepseek", SPLIT(0.5, 2)],
  ["qwen", { mode: "blended", usdPerMTok: 0.3 }],
  ["mistral", SPLIT(1, 3)],
  ["kimi", SPLIT(0.6, 2.5)],
  ["glm", SPLIT(0.5, 2)],
  ["llama", { mode: "blended", usdPerMTok: 0.4 }],
];

const DEFAULT_ESTIMATE_PRICING: ModelPricing = { mode: "blended", usdPerMTok: 1 };

export function resolveModelPricing(pricingOrModelId?: ModelPricing | string): ModelPricing {
  if (pricingOrModelId && typeof pricingOrModelId === "object") {
    return pricingOrModelId;
  }
  const normalized = (pricingOrModelId ?? "").toLowerCase();
  const match = MODEL_PRICE_TIERS.find(([needle]) => normalized.includes(needle));
  return match ? match[1] : DEFAULT_ESTIMATE_PRICING;
}

/** Pre-run credit estimate for a model (from its catalog pricing or model id) and task (#643). */
export function estimateRunCredits(
  pricingOrModelId?: ModelPricing | string,
  task: RunTaskKind = "build",
): number {
  const pricing = resolveModelPricing(pricingOrModelId);
  return Math.max(1, creditsForCost(costUsd(pricing, RUN_TASK_TOKEN_ESTIMATE[task])));
}

/** Why a platform run can't start: the month's grant or today's cap is spent. */
export type CreditRefusal = "month_used_up" | "day_used_up";

export function creditRefusal(
  plan: Plan,
  usage: CreditUsage | null,
  now: number,
  requiredCredits = 1,
): CreditRefusal | null {
  const needed = Math.max(1, Math.ceil(requiredCredits));
  const { monthLeft, dayLeft } = creditStanding(plan, usage, now);
  if (monthLeft < needed) return "month_used_up";
  if (dayLeft !== null && dayLeft < needed) return "day_used_up";
  return null;
}

/** The send routes' answer, with `code: "insufficient_credits"`. */
export const CREDIT_REFUSAL_MESSAGES: Record<CreditRefusal, string> = {
  month_used_up:
    "You've used this month's free credits. Add your own key in Settings → AI providers for unlimited runs.",
  day_used_up:
    "You've used today's free credits. They reset at midnight UTC, or add your own key in Settings → AI providers for unlimited runs.",
};

export function creditRefusalMessage(
  reason: CreditRefusal,
  details?: { left?: number; requiredCredits?: number; modelName?: string },
): string {
  if (
    details?.left !== undefined &&
    details.left > 0 &&
    details.requiredCredits &&
    details.requiredCredits > details.left
  ) {
    const modelNote = details.modelName ? ` on ${details.modelName}` : "";
    const creditWord = details.left === 1 ? "credit" : "credits";
    return reason === "day_used_up"
      ? `This run needs ~${details.requiredCredits} credits${modelNote}, and you have ${details.left} ${creditWord} left today. Pick a lighter model, add your own key in Settings → AI providers, or wait until midnight UTC.`
      : `This run needs ~${details.requiredCredits} credits${modelNote}, and you have ${details.left} ${creditWord} left this month. Pick a lighter model or add your own key in Settings → AI providers.`;
  }
  return CREDIT_REFUSAL_MESSAGES[reason];
}

export const INSUFFICIENT_CREDITS_CODE = "insufficient_credits";
