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

/**
 * Credits a run costs: 1 credit is $0.01 of billed value, marked up 1.5x and
 * rounded up so a tiny run never bills zero (#105).
 */
export const creditsForUsageUsd = (costUsd: number) =>
  Number.isFinite(costUsd) && costUsd > 0 ? Math.ceil(costUsd * 1.5 * 100) : 0;

/** How long a monthly grant lasts before it rolls over (30 days). */
export const CREDIT_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/** How long a day's allowance lasts before `dailyUsed` resets. */
export const DAILY_PERIOD_MS = 24 * 60 * 60 * 1000;
