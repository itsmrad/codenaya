import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { markPollDue } from "./billingPoll";

export const DELETION_BATCH = 20;

/** Call only for new evidence: invalidate recovery reads and give the new obligation its own retry budget. */
export async function queueDeletionRecovery(ctx: MutationCtx, customerRef: Id<"billingCustomers">) {
  const customer = await ctx.db.get("billingCustomers", customerRef);
  if (!customer) return;
  await ctx.db.patch("billingCustomers", customerRef, {
    cancellationRecoveryRequired: true,
    cancellationNextAttemptAt: Date.now(),
    cancellationLastOutcome: "pending", cancellationAttempts: 0,
    inputRevision: customer.inputRevision + 1,
  });
  await markPollDue(ctx, customerRef, false);
}

/** Runs in the Clerk tombstone transaction. Financial rows deliberately survive the app-data purge. */
export async function markBillingDeleted(ctx: MutationCtx, clerkUserId: string, now: number): Promise<void> {
  for (const mode of ["test_mode", "live_mode"] as const) {
    const customer = await ctx.db.query("billingCustomers")
      .withIndex("by_mode_and_userId", q => q.eq("mode", mode).eq("userId", clerkUserId)).unique();
    if (!customer) continue;
    const first = customer.deletedAt === undefined;
    await ctx.db.patch("billingCustomers", customer._id, {
      deletedAt: customer.deletedAt ?? now, hold: true,
      generation: customer.generation + 1, inputRevision: customer.inputRevision + 1,
      ...(first || customer.cancellationLastOutcome === undefined ? {
        cancellationRecoveryRequired: true, cancellationNextAttemptAt: now, cancellationLastOutcome: "pending" as const,
      } : {}),
    });
    await markPollDue(ctx, customer._id, false);
    for (const table of ["purchases", "subscriptions"] as const) {
      await ctx.scheduler.runAfter(0, internal.billingDeletion.markDeletionBatch, { customerRef: customer._id, table, cursor: null });
    }
  }
}

export const markDeletionBatch = internalMutation({
  args: {
    customerRef: v.id("billingCustomers"), table: v.union(v.literal("purchases"), v.literal("subscriptions")),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, { customerRef, table, cursor }) => {
    const customer = await ctx.db.get("billingCustomers", customerRef);
    if (customer?.deletedAt === undefined) return null;
    const opts = { numItems: DELETION_BATCH, cursor };
    let marked = false;
    if (table === "purchases") {
      const page = await ctx.db.query("billingPurchases")
        .withIndex("by_customerRef_and_state", q => q.eq("customerRef", customerRef)).paginate(opts);
      for (const row of page.page) {
        if (row.cancellationRecoveryRequired || !["settled", "terminal"].includes(row.state)) {
          await ctx.db.patch("billingPurchases", row._id, { cancellationRecoveryRequired: true });
          marked ||= !row.cancellationRecoveryRequired || customer.cancellationLastOutcome === "complete";
        }
      }
      if (!page.isDone) await ctx.scheduler.runAfter(0, internal.billingDeletion.markDeletionBatch,
        { customerRef, table, cursor: page.continueCursor });
    } else {
      const page = await ctx.db.query("billingSubscriptions")
        .withIndex("by_customerRef_and_status", q => q.eq("customerRef", customerRef)).paginate(opts);
      // Even a locally ended subscription needs provider confirmation, not a blanket local clearance.
      for (const row of page.page) {
        await ctx.db.patch("billingSubscriptions", row._id, { cancellationRecoveryRequired: true });
        marked ||= !row.cancellationRecoveryRequired || customer.cancellationLastOutcome === "complete";
      }
      if (!page.isDone) await ctx.scheduler.runAfter(0, internal.billingDeletion.markDeletionBatch,
        { customerRef, table, cursor: page.continueCursor });
    }
    if (marked) await queueDeletionRecovery(ctx, customerRef);
    return null;
  },
});
