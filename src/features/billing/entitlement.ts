import { type CreditUsage, creditStanding, currentUsage } from "./credits";
import { currentFreeAllocation, freeRemaining, paidAccountAvailability } from "./free-allocation";
import { type GrantLot, isInPaidPeriod, lotRemaining } from "./grants";
import { PLANS } from "./plans";

/**
 * What an account may use and spend now (stage 11). Pure on purpose: the
 * Convex reader, the send gates and the billing views share one rule. Settled
 * period lots decide the plan; stored `creditAccounts.plan` never does.
 */

export interface Entitlement {
  plan: "free" | "pro";
  /** End of the paid interval live now, through adjacent early renewals. Null on Free. */
  paidThroughMs: number | null;
  /** Whether platform-funded calls may run; BYOK follows its own rules. */
  platformAllowed: boolean;
  reason: "deleted" | "on_hold" | null;
}

export type PeriodLot = GrantLot & { serviceStart?: number; serviceEnd?: number };

/** A period lot that grants Pro somewhere in its service interval. */
const countsForPeriod = (lot: PeriodLot) =>
  lot.kind === "current_period" && lot.fullyReversed !== true && lot.serviceStart !== undefined;

/**
 * Pro iff the account is billing-enabled here and holds a started, unexpired,
 * not fully reversed period lot, spent or not. A hold keeps the plan label but
 * stops platform use; deletion stops everything.
 */
export function entitlement(
  input: { enabled: boolean; periodLots: PeriodLot[]; deleted: boolean; held: boolean },
  now: number,
): Entitlement {
  const reason = input.deleted ? "deleted" : input.held ? "on_hold" : null;
  const pro = input.enabled && !input.deleted && isInPaidPeriod(input.periodLots, now);
  return { plan: pro ? "pro" : "free", paidThroughMs: pro ? paidThrough(input.periodLots, now) : null, platformAllowed: reason === null, reason };
}

/** Extends the live interval through lots that start before it ends; never across a gap. */
function paidThrough(lots: PeriodLot[], now: number) {
  const periods = lots.filter(countsForPeriod);
  let end = now;
  for (let extended = true; extended; ) {
    extended = false;
    for (const lot of periods) {
      if (lot.serviceStart! <= end && lot.expiresAt > end) {
        end = lot.expiresAt;
        extended = true;
      }
    }
  }
  return end;
}

export interface EntitlementView extends Entitlement {
  /** Derived from the account's paid markers; never enables anything. */
  billingEnabled: boolean;
  /** What a platform run may spend now: within today's cap on Free, zero when not allowed. */
  creditsLeft: number;
  /** Gross unspent paid lots, before debt. */
  paidCreditsRemaining: number;
  /** This month's Free allocation left; null in a paid period. */
  freeRemaining: number | null;
  debt: number;
  /** Null when no daily cap applies (a paid period). */
  dayLeft: number | null;
  dayResetsAt: number;
  monthResetsAt: number;
  /** The next paid-period start or end, or lot expiry, that changes this view. */
  nextChangeAt: number | null;
}

export interface AvailabilityInput {
  account: (CreditUsage & { freeMonthStartsAt?: number; freeUsed?: number; freeDebtOffset?: number }) | null;
  enabled: boolean;
  periodLots: PeriodLot[];
  /** The exact bounded lot set spending reads, so the display never exceeds what spend reaches. */
  activeLots: GrantLot[];
  /** Stored `creditDebt`, before this month's Free offset. */
  debt: number;
  deleted: boolean;
  held: boolean;
}

/**
 * The account's plan, permission and spendable credits at `now`. Legacy
 * accounts (no paid markers) keep the Free monthly grant, whatever their
 * stored plan says. Off a paid period the month's Free allocation pays debt
 * first, as the first charge will persist it; repeated reads change nothing.
 */
export function accountAvailability(input: AvailabilityInput, now: number): EntitlementView {
  const ent = entitlement(input, now);
  const standing = creditStanding(PLANS.free, input.account, now);
  const resets = { dayResetsAt: standing.dayResetsAt, monthResetsAt: standing.monthResetsAt };
  const view = (fields: Pick<EntitlementView, "creditsLeft" | "paidCreditsRemaining" | "freeRemaining" | "debt" | "dayLeft">) => ({
    ...ent,
    billingEnabled: input.enabled,
    ...fields,
    creditsLeft: ent.platformAllowed ? fields.creditsLeft : 0,
    ...resets,
    nextChangeAt: nextChange(input, ent, now),
  });
  if (!input.enabled) {
    return view({ creditsLeft: standing.left, paidCreditsRemaining: 0, freeRemaining: standing.monthLeft, debt: 0, dayLeft: standing.dayLeft });
  }
  const lotsRemaining = input.activeLots.reduce((sum, lot) => sum + lotRemaining(lot, now), 0);
  const inPaidPeriod = ent.plan === "pro";
  if (inPaidPeriod) {
    const creditsLeft = paidAccountAvailability({ inPaidPeriod, freeRemaining: 0, lotsRemaining, debt: input.debt, dayUsed: 0 });
    return view({ creditsLeft, paidCreditsRemaining: lotsRemaining, freeRemaining: null, debt: input.debt, dayLeft: null });
  }
  const { allocation, debt } = currentFreeAllocation(input.account, input.debt, now);
  const free = freeRemaining(allocation);
  const { dayUsed } = currentUsage(input.account, now);
  const creditsLeft = paidAccountAvailability({ inPaidPeriod, freeRemaining: free, lotsRemaining, debt, dayUsed });
  const dayLeft = Math.max(0, (PLANS.free.dailyCreditCap ?? Infinity) - dayUsed);
  return view({ creditsLeft, paidCreditsRemaining: lotsRemaining, freeRemaining: free, debt, dayLeft });
}

/** The earliest future moment the plan or a lot balance changes on its own. */
function nextChange(input: AvailabilityInput, ent: Entitlement, now: number) {
  if (!input.enabled || input.deleted) return null;
  const starts = input.periodLots.filter(countsForPeriod).map((lot) => lot.serviceStart!);
  const candidates = [ent.paidThroughMs ?? Infinity, ...starts, ...input.activeLots.map((lot) => lot.expiresAt)];
  const next = Math.min(...candidates.filter((at) => at > now));
  return Number.isFinite(next) ? next : null;
}
