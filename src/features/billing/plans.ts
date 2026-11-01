/**
 * Plan numbers, the single source for the pricing page and for billing (#105).
 * 1 credit = $0.01 of AI usage.
 */
export const CREDIT_VALUE_USD = 0.01;

export type PlanId = "free" | "pro";

export type Plan = {
  id: PlanId;
  name: string;
  priceUsdPerMonth: number;
  monthlyCredits: number;
  /** Credits a user can spend per day; `null` means no daily cap. */
  dailyCreditCap: number | null;
  allModels: boolean;
  canBuyTopUps: boolean;
};

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    priceUsdPerMonth: 0,
    monthlyCredits: 300,
    dailyCreditCap: 60,
    allModels: false,
    canBuyTopUps: false,
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceUsdPerMonth: 20,
    monthlyCredits: 2_000,
    dailyCreditCap: null,
    allModels: true,
    canBuyTopUps: true,
  },
};

/** One-time credit pack, for paid plans only. */
export const TOP_UP = {
  priceUsd: 10,
  credits: 1_000,
} as const;

/** Formats a credit count for display, e.g. 2000 -> "2,000". */
export const formatCredits = (credits: number) => credits.toLocaleString("en-US");

// ==========================================
// Pre-Run Cost Estimation (v1 - Static profiles per #105)
// ==========================================

export type RunTaskKind = "plan" | "first_build" | "quick_edit" | "error_fix";

export interface TokenProfile {
  promptTokens: number;
  completionTokens: number;
}

/** Standard token usage profiles per task kind (from historical OpenRouter telemetry). */
export const TASK_TOKEN_PROFILES: Record<RunTaskKind, TokenProfile> = {
  plan: { promptTokens: 30_000, completionTokens: 2_000 },
  first_build: { promptTokens: 350_000, completionTokens: 35_000 },
  quick_edit: { promptTokens: 56_000, completionTokens: 4_000 },
  error_fix: { promptTokens: 108_000, completionTokens: 8_000 },
};

export interface ModelPricing {
  promptPricePerMillion: number;
  completionPricePerMillion: number;
}

/** Canonical catalog pricing per 1M tokens (`resolveModelPricing` normalizes bare/hyphenated aliases). */
export const MODEL_LIST_PRICES: Record<string, ModelPricing> = {
  // Anthropic canonical catalog IDs
  "claude-haiku-4-5": { promptPricePerMillion: 0.8, completionPricePerMillion: 4.0 },
  "anthropic/claude-haiku-5.5": { promptPricePerMillion: 0.8, completionPricePerMillion: 4.0 },
  "anthropic/claude-sonnet-5.5": { promptPricePerMillion: 3.0, completionPricePerMillion: 15.0 },
  "anthropic/claude-opus-5.5": { promptPricePerMillion: 15.0, completionPricePerMillion: 75.0 },
  "anthropic/claude-fable-5.1": { promptPricePerMillion: 1.5, completionPricePerMillion: 7.5 },
  // OpenAI canonical catalog IDs
  "openai/gpt-5.4-mini": { promptPricePerMillion: 0.15, completionPricePerMillion: 0.6 },
  "openai/gpt-5.6-luna": { promptPricePerMillion: 1.5, completionPricePerMillion: 6.0 },
  "openai/gpt-5.6-sol": { promptPricePerMillion: 2.5, completionPricePerMillion: 10.0 },
  "openai/gpt-6-luna": { promptPricePerMillion: 2.5, completionPricePerMillion: 10.0 },
  "openai/gpt-6.1-sol": { promptPricePerMillion: 5.0, completionPricePerMillion: 20.0 },
  // OpenRouter multi-vendor catalog IDs
  "google/gemini-3.1-pro-preview": { promptPricePerMillion: 1.25, completionPricePerMillion: 5.0 },
  "google/gemini-3.8-flash": { promptPricePerMillion: 0.15, completionPricePerMillion: 0.6 },
  "x-ai/grok-4.7": { promptPricePerMillion: 3.0, completionPricePerMillion: 15.0 },
  "deepseek/deepseek-v4-pro-0813": { promptPricePerMillion: 0.28, completionPricePerMillion: 1.1 },
  "qwen/qwen3.8-max-0902": { promptPricePerMillion: 1.6, completionPricePerMillion: 6.4 },
  "mistralai/mistral-large-4-0": { promptPricePerMillion: 2.0, completionPricePerMillion: 6.0 },
  "moonshotai/kimi-k3": { promptPricePerMillion: 0.6, completionPricePerMillion: 2.5 },
  "z-ai/glm-5.3": { promptPricePerMillion: 0.5, completionPricePerMillion: 2.0 },
  "meta-llama/llama-4-maverick": { promptPricePerMillion: 0.2, completionPricePerMillion: 0.6 },
  // Groq catalog IDs
  "openai/gpt-oss-20b": { promptPricePerMillion: 0.1, completionPricePerMillion: 0.3 },
  "openai/gpt-oss-120b": { promptPricePerMillion: 0.5, completionPricePerMillion: 1.5 },
  "qwen/qwen3.8-27b": { promptPricePerMillion: 0.3, completionPricePerMillion: 0.9 },
};

/** Resolves model pricing by exact ID or normalized provider/version alias. */
export function resolveModelPricing(modelId: string): ModelPricing | undefined {
  if (MODEL_LIST_PRICES[modelId]) {
    return MODEL_LIST_PRICES[modelId];
  }
  const slashIdx = modelId.indexOf("/");
  const bare = slashIdx !== -1 ? modelId.slice(slashIdx + 1) : modelId;
  const dotVersion = bare.replace(/-(\d+)-(\d+)$/, "-$1.$2");
  const candidates = [
    bare,
    dotVersion,
    `anthropic/${bare}`,
    `anthropic/${dotVersion}`,
    `openai/${bare}`,
  ];
  for (const key of candidates) {
    if (MODEL_LIST_PRICES[key]) {
      return MODEL_LIST_PRICES[key];
    }
  }
  return undefined;
}

/**
 * Calculates estimated credits for a run given model list price and markup multiplier (1.5x).
 * Formula from #105: ceil(costUsd * 1.5 * 100)
 */
export function estimateRunCredits(
  modelId: string,
  taskKind: RunTaskKind = "quick_edit",
  isFree: boolean = false
): { credits: number | null; costUsd: number | null } {
  if (isFree) {
    return { credits: 0, costUsd: 0 };
  }

  const pricing = resolveModelPricing(modelId);
  if (!pricing) {
    return { credits: null, costUsd: null };
  }

  const profile = TASK_TOKEN_PROFILES[taskKind] ?? TASK_TOKEN_PROFILES.quick_edit;

  const rawCostUsd =
    (profile.promptTokens / 1_000_000) * pricing.promptPricePerMillion +
    (profile.completionTokens / 1_000_000) * pricing.completionPricePerMillion;

  // 1.5x platform margin, converted to $0.01 credits
  const credits = Math.ceil(rawCostUsd * 1.5 * 100);
  return { credits, costUsd: rawCostUsd };
}
