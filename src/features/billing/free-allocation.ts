import { startOfUtcMonth } from "./credits";
import { PLANS } from "./plans";

/**
 * The Free allocation of a billing-enabled account (ADR 0016): 300 credits per
 * UTC month, spent before retained paid lots and kept apart from the usage
 * counters. Pure on purpose: the charge mutation and the send gates share it.
 */

export interface FreeAllocation {
  monthStartsAt: number;
  used: number;
  /** The part of this month's allocation that paid off earlier debt. */
  debtOffset: number;
}

/**
 * The account's allocation for `now`'s UTC month. A new month starts at used 0
 * and pays off up to the whole allocation of debt, once: a month already
 * stored keeps its values. Returns the debt left after that offset.
 */
export function currentFreeAllocation(
  stored: { freeMonthStartsAt?: number; freeUsed?: number; freeDebtOffset?: number } | null,
  debt: number,
  now: number,
): { allocation: FreeAllocation; debt: number } {
  const monthStartsAt = startOfUtcMonth(now);
  if (stored?.freeMonthStartsAt === monthStartsAt) {
    return { allocation: { monthStartsAt, used: stored.freeUsed ?? 0, debtOffset: stored.freeDebtOffset ?? 0 }, debt };
  }
  const debtOffset = Math.min(debt, PLANS.free.monthlyCredits);
  return { allocation: { monthStartsAt, used: 0, debtOffset }, debt: debt - debtOffset };
}

export const freeRemaining = (allocation: FreeAllocation) =>
  Math.max(0, PLANS.free.monthlyCredits - allocation.used - allocation.debtOffset);

/**
 * Credits a billing-enabled account can spend now, for display and send gates.
 * On Free: the allocation plus paid lots minus debt, within today's cap; the
 * 300 a month never limits purchased credits. In a paid period: lots minus
 * debt, no daily cap. `debt` is what is left after the month's offset, and
 * `dayUsed` today's usage.
 */
export function paidAccountAvailability(input: {
  inPaidPeriod: boolean;
  freeRemaining: number;
  lotsRemaining: number;
  debt: number;
  dayUsed: number;
}): number {
  if (input.inPaidPeriod) return Math.max(0, input.lotsRemaining - input.debt);
  const dayLeft = Math.max(0, (PLANS.free.dailyCreditCap ?? Infinity) - input.dayUsed);
  return Math.min(dayLeft, Math.max(0, input.freeRemaining + input.lotsRemaining - input.debt));
}
