import type { Infer } from "convex/values";

import type { billingGrantKindValidator } from "../../../convex/schema";
import { PLANS } from "./plans";

/**
 * How a usage charge spends paid credit lots (ADR 0016). Pure on purpose:
 * Convex runs it inside the charging mutation, and tests pin the order.
 */

export type GrantKind = Infer<typeof billingGrantKindValidator>;

/** Spending order across kinds: the current period first, top-ups last. */
const KIND_ORDER: readonly GrantKind[] = ["current_period", "rollover", "top_up"];

export interface GrantLot {
  _id: string;
  kind: GrantKind;
  quantity: number;
  consumed: number;
  revoked: number;
  expiresAt: number;
  /** A period lot's first moment; nothing on it is spendable before then. */
  serviceStart?: number;
  /** Carried into the next period's rollover lot. */
  transferred?: number;
  /** Paid toward recorded debt when the lot was granted. */
  debtOffset?: number;
  /** Its purchase was fully refunded or lost a dispute. */
  fullyReversed?: true;
}

/** Credits of `lot` nobody spent, revoked, carried over or used to pay debt, ignoring expiry. */
export const lotUnspent = (lot: Omit<GrantLot, "_id" | "kind" | "expiresAt">) =>
  Math.max(0, lot.quantity - lot.consumed - lot.revoked - (lot.transferred ?? 0) - (lot.debtOffset ?? 0));

/** Whether `lot` holds credits for `now`: unexpired, and its service interval (if any) has started. */
const isLive = (lot: GrantLot, now: number) => lot.expiresAt > now && (lot.serviceStart === undefined || lot.serviceStart <= now);

/**
 * Credits still spendable on `lot` at `now`: none once it has expired, and none
 * yet on a period lot whose service hasn't started (a renewal settled early).
 */
export const lotRemaining = (lot: GrantLot, now: number) => (isLive(lot, now) ? lotUnspent(lot) : 0);

/** Most unused period credits carried into the next paid period. */
export const ROLLOVER_CAP = PLANS.pro.monthlyCredits;

/**
 * What a period lot carries into the next period. Measured at the boundary,
 * not at `now`: a renewal settles just after the source expired, and an expired
 * lot can't be spent, so its unspent balance is what was left when it ended.
 */
export const rolloverQuantity = (source: GrantLot) => Math.min(ROLLOVER_CAP, lotUnspent(source));

/** A top-up's expiry: 12 calendar months after settlement in UTC, the day clamped to the month's end. */
export function topUpExpiresAt(settledAt: number): number {
  const at = new Date(settledAt);
  const year = at.getUTCFullYear() + 1;
  const month = at.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  at.setUTCFullYear(year, month, Math.min(at.getUTCDate(), lastDay));
  return at.getTime();
}

/**
 * Whether the account is in a paid period at `now`: it holds an unexpired,
 * started period lot, spent or not, so a Pro user who used up the period stays
 * off the Free allocation. A fully reversed period lot never counts: after
 * spending, its revoked credits stay below its quantity. Stage 11's
 * entitlement rule may replace this.
 */
export const isInPaidPeriod = (lots: GrantLot[], now: number) =>
  lots.some(
    (lot) => lot.kind === "current_period" && lot.fullyReversed !== true && lot.serviceStart !== undefined && isLive(lot, now),
  );

/**
 * Spends `credits` across the lots live at `now`: current period, then
 * rollover, then the earliest-expiring top-up, equal expiries tie-broken by id.
 * A next period's lot settled early waits for its serviceStart. What the lots
 * can't cover is the shortfall, which the caller records as debt.
 */
export function allocateCredits<T extends GrantLot>(lots: T[], credits: number, now: number) {
  const ordered = lots
    .filter((lot) => lotRemaining(lot, now) > 0)
    .sort(
      (a, b) =>
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
        a.expiresAt - b.expiresAt ||
        (a._id < b._id ? -1 : a._id > b._id ? 1 : 0),
    );
  const takes: { lot: T; credits: number }[] = [];
  let left = credits;
  for (const lot of ordered) {
    if (left <= 0) break;
    const take = Math.min(left, lotRemaining(lot, now));
    takes.push({ lot, credits: take });
    left -= take;
  }
  return { takes, shortfall: Math.max(0, left) };
}
