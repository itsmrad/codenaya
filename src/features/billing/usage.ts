import { type CreditUsage, creditStanding } from "./credits";
import { CREDIT_VALUE_USD, PLANS, type Plan, type PlanId } from "./plans";

/** Below this share of the day's or the month's grant, the composer warns (#526). */
export const LOW_CREDITS_SHARE = 0.2;

export interface Allowance {
  left: number;
  total: number;
  /** 0 to 100, for the bar. */
  percentLeft: number;
}

export interface UsageView {
  plan: Plan;
  month: Allowance;
  /** Null when the plan has no daily cap. */
  day: Allowance | null;
  monthResetsAt: number;
  dayResetsAt: number;
  isLow: boolean;
}

const allowance = (left: number, total: number): Allowance => ({
  left,
  total,
  percentLeft: total > 0 ? Math.round((left / total) * 100) : 0,
});

/**
 * What the Usage tab and the composer show for `api.credits.getMine`'s answer.
 * No account yet (no metered run) means the full free grant.
 */
export function usageView(account: (CreditUsage & { plan: PlanId }) | null, now: number): UsageView {
  const plan = PLANS[account?.plan ?? "free"];
  const standing = creditStanding(plan, account, now);
  const month = allowance(standing.monthLeft, plan.monthlyCredits);
  const day =
    standing.dayLeft === null || plan.dailyCreditCap === null
      ? null
      : allowance(standing.dayLeft, plan.dailyCreditCap);
  const isLow = [month, day].some((a) => a !== null && a.left < a.total * LOW_CREDITS_SHARE);
  return { plan, month, day, monthResetsAt: standing.monthResetsAt, dayResetsAt: standing.dayResetsAt, isLow };
}

/**
 * A reset time in the viewer's time zone, with its name, e.g. "Nov 16, 5:30 AM
 * GMT+5:30": resets happen at UTC midnight, which is rarely local midnight.
 */
export const formatResetTime = (at: number, timeZone?: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone,
  }).format(at);

/** A finished run's cost chip, e.g. "≈ $0.04"; null when it cost no credits. */
export const runCostLabel = (credits: number | null | undefined) =>
  credits ? `≈ $${(credits * CREDIT_VALUE_USD).toFixed(2)}` : null;
