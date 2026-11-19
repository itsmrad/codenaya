import { v } from "convex/values";

import { creditStanding } from "../src/features/billing/credits";
import { currentFreeAllocation, freeRemaining } from "../src/features/billing/free-allocation";
import { isInPaidPeriod, lotRemaining } from "../src/features/billing/grants";
import { PLANS } from "../src/features/billing/plans";
import { query } from "./_generated/server";
import { verifyAuth } from "./auth";
import { readActiveLots, readPeriodLots } from "./billingGrants";

/**
 * The caller's plan and credits for the Billing tab (ADR 0016). `now` comes
 * from the client's clock: a query can't read one. It only shapes the caller's
 * own view, so a wrong clock misleads nobody else.
 */
export const mine = query({
  args: { now: v.number() },
  returns: v.object({
    plan: v.union(v.literal("pro"), v.literal("free")),
    paidThroughMs: v.union(v.number(), v.null()),
    paidCreditsRemaining: v.number(),
    freeRemaining: v.union(v.number(), v.null()),
    debt: v.number(),
  }),
  handler: async (ctx, { now }) => {
    const identity = await verifyAuth(ctx);
    const account = await ctx.db
      .query("creditAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .unique();
    const mode = account?.paidCreditsVersion === undefined ? undefined : account.paidCreditsMode;
    if (!account || mode === undefined) {
      // Not billing-enabled: only the legacy monthly grant applies.
      const plan = PLANS[account?.plan ?? "free"];
      const left = creditStanding(plan, account, now).monthLeft;
      return { plan: "free" as const, paidThroughMs: null, paidCreditsRemaining: 0, freeRemaining: left, debt: 0 };
    }
    const periodLots = await readPeriodLots(ctx, identity.subject, mode, now);
    const inPaidPeriod = isInPaidPeriod(periodLots, now);
    const { lots } = await readActiveLots(ctx, identity.subject, mode, now);
    // Off a paid period, the month's first charge pays debt from the Free allocation; show that now.
    const { allocation, debt } = currentFreeAllocation(account, account.creditDebt ?? 0, now);
    return {
      plan: inPaidPeriod ? ("pro" as const) : ("free" as const),
      // A renewal settled early extends this past the live period's end.
      paidThroughMs: inPaidPeriod ? Math.max(...periodLots.map((lot) => lot.expiresAt)) : null,
      paidCreditsRemaining: lots.reduce((sum, lot) => sum + lotRemaining(lot, now), 0),
      // In a paid period the Free allocation isn't spent.
      freeRemaining: inPaidPeriod ? null : freeRemaining(allocation),
      debt: inPaidPeriod ? (account.creditDebt ?? 0) : debt,
    };
  },
});
