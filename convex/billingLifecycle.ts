import { v } from "convex/values";
import { canUncancel } from "../src/features/billing/subscription-controls";
import { mutation, type MutationCtx } from "./_generated/server";
import { verifyAuth } from "./auth";
import { ownerDeleted } from "./billing";
import { markPollDue } from "./billingPoll";
import { hasActiveHold } from "./billingReversals";
import { appError } from "./errors";
import { validateInternalKey } from "./internalKey";
import { billingModeValidator } from "./schema";

async function authorize(ctx: MutationCtx, internalKey: string) {
  validateInternalKey(internalKey);
  return await verifyAuth(ctx);
}
const operation = v.union(v.literal("cancel"), v.literal("uncancel"));
const code = v.union(v.literal("not_subscribed"), v.literal("on_hold"), v.literal("control_pending"), v.literal("expired"), v.literal("unavailable"));
const refused = (code: "not_subscribed" | "on_hold" | "control_pending" | "expired" | "unavailable") => ({ kind: "refused" as const, code });

export const prepareControl = mutation({
  args: { internalKey: v.string(), mode: billingModeValidator, operation },
  returns: v.union(v.object({ kind: v.literal("refused"), code }), v.object({
    kind: v.literal("call"), subscriptionRef: v.id("billingSubscriptions"), subscriptionId: v.string(), customerId: v.string(), revision: v.number(),
  })),
  handler: async (ctx, args) => {
    const identity = await authorize(ctx, args.internalKey);
    const customer = await ctx.db.query("billingCustomers").withIndex("by_mode_and_userId", q =>
      q.eq("mode", args.mode).eq("userId", identity.subject)).unique();
    if (!customer || customer.ownerTokenIdentifier !== identity.tokenIdentifier || customer.userId !== identity.subject ||
      await ownerDeleted(ctx, customer)) return refused("unavailable");
    const sub = customer.activeSubscriptionRef && await ctx.db.get("billingSubscriptions", customer.activeSubscriptionRef);
    if (!sub || sub.customerRef !== customer._id || sub.mode !== args.mode || !customer.customerId) return refused("not_subscribed");
    if (sub.controlPendingAt !== undefined) return refused("control_pending");
    if (args.operation === "uncancel") {
      const held = customer.hold || await hasActiveHold(ctx, customer._id);
      if (held) return refused("on_hold");
      if (!canUncancel({ deleted: false, held, renewable: sub.controlRenewable === true,
        cancelAt: sub.cancelAt, paidThrough: sub.paidThrough }, Date.now())) return refused("expired");
    }
    const revision = (sub.controlRevision ?? 0) + 1;
    await ctx.db.patch("billingSubscriptions", sub._id, {
      controlOperation: args.operation, controlRevision: revision, controlPendingAt: Date.now(),
    });
    // Also covers a route crash before recordControlResult.
    await markPollDue(ctx, customer._id, false);
    return { kind: "call" as const, subscriptionRef: sub._id, subscriptionId: sub.subscriptionId, customerId: customer.customerId, revision };
  },
});

export const recordControlResult = mutation({
  args: { internalKey: v.string(), subscriptionRef: v.id("billingSubscriptions"), revision: v.number(),
    outcome: v.union(v.literal("confirmed"), v.literal("unknown"), v.literal("refused")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await authorize(ctx, args.internalKey);
    const sub = await ctx.db.get("billingSubscriptions", args.subscriptionRef);
    const customer = sub && await ctx.db.get("billingCustomers", sub.customerRef);
    if (!customer || customer.ownerTokenIdentifier !== identity.tokenIdentifier || customer.userId !== identity.subject) {
      throw appError("NOT_FOUND", "Billing record not found");
    }
    if (sub!.controlRevision !== args.revision) throw appError("CONFLICT", "Control state changed");
    if (args.outcome === "refused") await ctx.db.patch("billingSubscriptions", sub!._id, {
      controlOperation: undefined, controlPendingAt: undefined,
    });
    await markPollDue(ctx, customer._id, false);
    return null;
  },
});
