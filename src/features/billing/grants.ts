import type { Infer } from "convex/values";

import type { billingGrantKindValidator } from "../../../convex/schema";

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
}

/** Credits still spendable on `lot` at `now`; none once it has expired. */
export const lotRemaining = (lot: GrantLot, now: number) =>
  lot.expiresAt > now ? Math.max(0, lot.quantity - lot.consumed - lot.revoked) : 0;

/**
 * Spends `credits` across `lots`: current period, then rollover, then the
 * earliest-expiring top-up, equal expiries tie-broken by id. What the lots
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
