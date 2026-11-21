import { v } from "convex/values";

import { accountAvailability, entitlement, type EntitlementView } from "../src/features/billing/entitlement";
import { mutation, type QueryCtx } from "./_generated/server";
import { deploymentBillingMode } from "./billingEnv";
import { halfPaidMarker, paidCreditsState, readActiveLots, readPeriodLots } from "./billingGrants";
import { hasActiveHold } from "./billingReversals";
import { validateInternalKey } from "./internalKey";

/**
 * The server's view of what a user may use and spend (stage 11): plan from
 * settled period lots in this deployment's billing mode, permission from
 * deletion and holds. Reads only; nothing here enables an account or writes.
 */

const LOG = "[billingEntitlement]";
const MODES = ["test_mode", "live_mode"] as const;

const planValidator = v.union(v.literal("free"), v.literal("pro"));
const reasonValidator = v.union(v.literal("deleted"), v.literal("on_hold"), v.null());

export const permissionValidator = v.object({ plan: planValidator, platformAllowed: v.boolean(), reason: reasonValidator });

export const entitlementViewValidator = v.object({
  plan: planValidator,
  paidThroughMs: v.union(v.number(), v.null()),
  platformAllowed: v.boolean(),
  reason: reasonValidator,
  billingEnabled: v.boolean(),
  creditsLeft: v.number(),
  paidCreditsRemaining: v.number(),
  freeRemaining: v.union(v.number(), v.null()),
  debt: v.number(),
  dayLeft: v.union(v.number(), v.null()),
  dayResetsAt: v.number(),
  monthResetsAt: v.number(),
  nextChangeAt: v.union(v.number(), v.null()),
});

/**
 * Everything entitlement needs except the active lots. Deleted: the user's
 * tombstone, or (as `ownerDeleted` reads it) a billing customer whose owner row
 * is gone or deleted. Held: any customer hold or active adjustment hold. With
 * no known deployment mode every mode's customer is checked for holds and paid
 * benefits stay off: never a guess, never test/live mixing.
 */
async function readOwner(ctx: QueryCtx, userId: string, now: number) {
  const mode = deploymentBillingMode();
  const user = await ctx.db.query("users").withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", userId)).unique();
  const customers = [];
  for (const m of mode ? [mode] : MODES) {
    const customer = await ctx.db
      .query("billingCustomers")
      .withIndex("by_mode_and_userId", (q) => q.eq("mode", m).eq("userId", userId))
      .unique();
    if (customer) customers.push(customer);
  }
  let held = false;
  for (const customer of customers) held ||= customer.hold === true || (await hasActiveHold(ctx, customer._id));
  const deleted = user?.deletedAt !== undefined || customers.some((c) => !user || c.deletedAt !== undefined);

  const account = await ctx.db.query("creditAccounts").withIndex("by_userId", (q) => q.eq("userId", userId)).unique();
  const markers = paidCreditsState(account);
  if (halfPaidMarker(account)) console.warn(`${LOG} half_paid_marker: userId=${userId}`);
  else if (markers.enabled && !mode) console.warn(`${LOG} deployment_mode_unknown: userId=${userId}`);
  else if (markers.enabled && markers.mode !== mode) console.warn(`${LOG} foreign_mode_marker: userId=${userId}`);
  const paidMode = markers.enabled && markers.mode === mode ? mode : null;
  const periodLots = paidMode ? await readPeriodLots(ctx, userId, paidMode, now) : [];
  return { account, paidMode, periodLots, deleted, held };
}

/** The user's full view at `now`: what send and run start check, and what billing pages show. */
export async function readAccountEntitlement(ctx: QueryCtx, userId: string, now: number): Promise<EntitlementView> {
  const { account, paidMode, periodLots, deleted, held } = await readOwner(ctx, userId, now);
  // The exact capped set spending reads, so the display never exceeds what spend reaches.
  const activeLots = paidMode ? (await readActiveLots(ctx, userId, paidMode, now)).lots : [];
  return accountAvailability(
    { account, enabled: paidMode !== null, periodLots, activeLots, debt: account?.creditDebt ?? 0, deleted, held },
    now,
  );
}

/**
 * `userId`'s view for the send routes and run start. A mutation so the clock
 * is the server's: authorization never takes a caller's `now`. It writes nothing.
 */
export const getForServer = mutation({
  args: { internalKey: v.string(), userId: v.string() },
  returns: entitlementViewValidator,
  handler: async (ctx, { internalKey, userId }) => {
    validateInternalKey(internalKey);
    return await readAccountEntitlement(ctx, userId, Date.now());
  },
});

/** The lean per-inference check: plan and permission, no active-lot scan. Writes nothing. */
export const permissionForServer = mutation({
  args: { internalKey: v.string(), userId: v.string() },
  returns: permissionValidator,
  handler: async (ctx, { internalKey, userId }) => {
    validateInternalKey(internalKey);
    const now = Date.now();
    const { paidMode, periodLots, deleted, held } = await readOwner(ctx, userId, now);
    const { plan, platformAllowed, reason } = entitlement({ enabled: paidMode !== null, periodLots, deleted, held }, now);
    return { plan, platformAllowed, reason };
  },
});
