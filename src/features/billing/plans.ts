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
