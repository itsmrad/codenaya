import { v } from "convex/values";
import { billingRetentionEndsAt } from "../src/features/billing/retention";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { hasActiveHold } from "./billingReversals";

export const RETENTION_BATCH = 10;
export const RETENTION_DELETE_BATCH = 190; // plus at most ten customer rows

async function eligible(ctx: MutationCtx, customer: Doc<"billingCustomers">, now: number) {
  const ref = customer._id;
  if (customer.deletedAt === undefined || now < billingRetentionEndsAt(customer.deletedAt)
    || customer.cancellationRecoveryRequired !== false || customer.cancellationLastOutcome !== "complete"
    || customer.unresolvedReceipts !== 0 || (customer.watchUntil ?? 0) > now
    || (customer.leaseExpiresAt ?? 0) > now || (customer.cancellationLeaseExpiresAt ?? 0) > now
    || customer.creationState !== "ready" || !customer.customerId || customer.pendingPurchaseRef !== undefined
    || customer.creationLeaseId !== undefined
    || (customer.cancellationLeaseId !== undefined && customer.cancellationLeaseExpiresAt === undefined)
    || (customer.leaseId !== undefined && customer.leaseExpiresAt === undefined)
    || (customer.cancellationProgress !== undefined && (customer.cancellationProgress.blocked || customer.cancellationProgress.phase !== "done"))) return false;
  if (await hasActiveHold(ctx, ref)) return false;
  for (const status of ["pending", "review", "other"] as const) {
    if (await ctx.db.query("billingAdjustments").withIndex("by_customerRef_and_kind_and_status",
      q => q.eq("customerRef", ref).eq("kind", "refund").eq("status", status)).first()) return false;
  }
  for (const table of ["billingPurchases", "billingSubscriptions"] as const) {
    if (await ctx.db.query(table).withIndex("by_customerRef_and_cancellationRecoveryRequired",
      q => q.eq("customerRef", ref).eq("cancellationRecoveryRequired", true)).first()) return false;
  }
  for (const state of ["preparing", "unknown", "open", "processing"] as const) {
    if (await ctx.db.query("billingPurchases").withIndex("by_customerRef_and_state",
      q => q.eq("customerRef", ref).eq("state", state)).first()) return false;
  }
  for (const state of ["pending", "processing", "quarantined"] as const) {
    if (await ctx.db.query("billingEvents").withIndex("by_customerRef_and_state_and_nextAttemptAt",
      q => q.eq("customerRef", ref).eq("state", state)).first()) return false;
  }
  if (await ctx.db.query("billingSubscriptions").withIndex("by_customerRef_and_controlPendingAt",
    q => q.eq("customerRef", ref).gt("controlPendingAt", undefined)).first()) return false;
  for (const operation of ["cancel", "uncancel"] as const) {
    if (await ctx.db.query("billingSubscriptions").withIndex("by_customerRef_and_controlOperation",
      q => q.eq("customerRef", ref).eq("controlOperation", operation)).first()) return false;
  }
  return true;
}

export const purgeExpiredBillingCustomers = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { cursor }): Promise<null> => {
    const now = Date.now();
    const page = await ctx.db.query("billingCustomers")
      .withIndex("by_deletedAt", q => q.gt("deletedAt", undefined).lte("deletedAt", now))
      .paginate({ cursor, numItems: RETENTION_BATCH });
    let remaining = RETENTION_DELETE_BATCH;
    for (const customer of page.page) {
      // Recheck every blocker on each transaction, including when a previous run deleted some children.
      if (!await eligible(ctx, customer, now)) continue;
      const ref = customer._id;
      const children = [
        ctx.db.query("billingGrants").withIndex("by_customerRef", q => q.eq("customerRef", ref)),
        ctx.db.query("billingAdjustments").withIndex("by_customerRef_and_holdActive", q => q.eq("customerRef", ref)),
        ctx.db.query("billingEvents").withIndex("by_customerRef_and_state_and_nextAttemptAt", q => q.eq("customerRef", ref)),
        ctx.db.query("billingPurchases").withIndex("by_customerRef_and_state", q => q.eq("customerRef", ref)),
        ctx.db.query("billingSubscriptions").withIndex("by_customerRef_and_status", q => q.eq("customerRef", ref)),
      ];
      for (const query of children) {
        // Destructive pagination drains the index prefix; the surviving customer is the resume marker.
        const rows = await query.take(remaining + 1);
        for (const row of rows.slice(0, remaining)) await ctx.db.delete(row._id);
        const deleted = Math.min(rows.length, remaining);
        remaining -= deleted;
        if (rows.length > deleted || remaining === 0) {
          await ctx.scheduler.runAfter(0, internal.billingRetention.purgeExpiredBillingCustomers, { cursor });
          return null;
        }
      }
      await ctx.db.delete("billingCustomers", ref);
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.billingRetention.purgeExpiredBillingCustomers, { cursor: page.continueCursor });
    return null;
  },
});
