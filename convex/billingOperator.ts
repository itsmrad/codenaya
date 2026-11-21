import { v } from "convex/values";

import { internalMutation } from "./_generated/server";
import { attachReceipts, bindCustomerRow, ownerDeleted } from "./billing";
import { scheduleCustomer } from "./billingQueue";
import { applyPurchaseReversal, queuePaymentRead } from "./billingReversals";
import { appError } from "./errors";

const auditArgs = { operator: v.string(), reason: v.string() };
function audit(action: string, operator: string, reason: string) {
  if (!operator.trim() || operator.length > 64 || operator.includes("@") || !reason.trim() || reason.length > 500) {
    throw appError("INVALID_ARGUMENT", "Provide an operator alias and a review reason");
  }
  return { action, operator, reason, at: Date.now() };
}

/** Dashboard-reviewed recovery only; production calls require explicit approval per run. */
export const resolveUnknownCustomer = internalMutation({
  args: { customerRef: v.id("billingCustomers"), customerId: v.optional(v.string()), ...auditArgs },
  returns: v.null(),
  handler: async (ctx, { customerRef, customerId, operator, reason }) => {
    const resolution = audit("resolveUnknownCustomer", operator, reason);
    const customer = await ctx.db.get("billingCustomers", customerRef);
    if (!customer) throw appError("NOT_FOUND", "Billing customer not found");
    if (customer.creationState !== "unknown") throw appError("INVALID_ARGUMENT", "Customer creation is not unknown");
    if (customerId !== undefined) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(customerId)) throw appError("INVALID_ARGUMENT", "Invalid customer identifier");
      await bindCustomerRow(ctx, { customerRef, customerId });
    } else {
      // Never discard a durable provider identity, including one kept for a held/deleted owner.
      if (customer.customerId !== undefined) throw appError("INVALID_ARGUMENT", "Customer already has a provider identifier");
      await ctx.db.patch("billingCustomers", customerRef, { creationState: "preparing" });
    }
    await ctx.db.patch("billingCustomers", customerRef, { creationLeaseId: undefined, creationLeasedAt: undefined, resolution });
    console.info("[billingOperator] resolved", { action: resolution.action, customerRef, operator });
    return null;
  },
});

/** Support must verify that the checkout is expired and unpaid before releasing it. */
export const releaseCheckoutLock = internalMutation({
  args: { customerRef: v.id("billingCustomers"), ...auditArgs },
  returns: v.null(),
  handler: async (ctx, { customerRef, operator, reason }) => {
    const resolution = audit("releaseCheckoutLock", operator, reason);
    const customer = await ctx.db.get("billingCustomers", customerRef);
    if (!customer) throw appError("NOT_FOUND", "Billing customer not found");
    const purchase = customer.pendingPurchaseRef && await ctx.db.get("billingPurchases", customer.pendingPurchaseRef);
    if (!purchase || purchase.customerRef !== customerRef || purchase.mode !== customer.mode ||
      purchase.state === "settled" || purchase.state === "processing" || purchase.paymentId !== undefined) {
      throw appError("INVALID_ARGUMENT", "Checkout cannot be released");
    }
    // Keep the session id: a late payment must still settle through the normal fenced path.
    await ctx.db.patch("billingPurchases", purchase._id, { state: "terminal", resolution });
    await ctx.db.patch("billingCustomers", customerRef, { pendingPurchaseRef: undefined });
    console.info("[billingOperator] resolved", { action: resolution.action, customerRef, purchaseRef: purchase._id, operator });
    return null;
  },
});

const negative = (type: string) => /^(refund|dispute)\./.test(type);

/** Repairs only quarantined receipts, using our mode-scoped payment binding as authority. */
export const resolveReceipt = internalMutation({
  args: { eventRef: v.id("billingEvents"), action: v.union(v.literal("attach"), v.literal("dismiss")), ...auditArgs },
  returns: v.null(),
  handler: async (ctx, { eventRef, action, operator, reason }) => {
    const resolution = audit(action, operator, reason);
    const row = await ctx.db.get("billingEvents", eventRef);
    if (!row) throw appError("NOT_FOUND", "Receipt not found");
    if (row.state !== "quarantined") throw appError("INVALID_ARGUMENT", "Receipt is not quarantined");
    const purchase = row.paymentId ? await ctx.db.query("billingPurchases")
      .withIndex("by_mode_and_paymentId", q => q.eq("mode", row.mode).eq("paymentId", row.paymentId)).unique() : null;
    const previous = { state: row.state, customerRef: row.customerRef, quarantineReason: row.quarantineReason };
    if (action === "attach") {
      if (!purchase) throw appError("NOT_FOUND", "Payment has no bound purchase");
      const owner = await ctx.db.get("billingCustomers", purchase.customerRef);
      if (!owner || owner.mode !== row.mode) throw appError("CONFLICT", "Payment owner mode differs");
      if (!row.customerRef) {
        await attachReceipts(ctx, owner._id, [row], true);
      } else {
        if (!negative(row.eventType) || row.quarantineReason !== "unsupported" || row.customerRef === owner._id) {
          throw appError("INVALID_ARGUMENT", "Receipt cannot be re-parented");
        }
        const old = await ctx.db.get("billingCustomers", row.customerRef);
        if (!old || old.mode !== row.mode) throw appError("CONFLICT", "Receipt owner mode differs");
        await ctx.db.patch("billingCustomers", old._id, { unresolvedReceipts: old.unresolvedReceipts - 1, inputRevision: old.inputRevision + 1 });
        await ctx.db.patch("billingCustomers", owner._id, { unresolvedReceipts: owner.unresolvedReceipts + 1, inputRevision: owner.inputRevision + 1 });
        await ctx.db.patch("billingEvents", eventRef, { customerRef: owner._id, state: "pending", quarantineReason: undefined, attempts: 0, nextAttemptAt: Date.now() });
        await scheduleCustomer(ctx, old._id);
        await scheduleCustomer(ctx, owner._id);
      }
    } else {
      if (row.customerRef ? negative(row.eventType) : purchase !== null) throw appError("INVALID_ARGUMENT", "Receipt must be reconciled");
      if (row.customerRef) {
        const customer = await ctx.db.get("billingCustomers", row.customerRef);
        if (!customer || customer.mode !== row.mode) throw appError("CONFLICT", "Receipt owner mode differs");
        await ctx.db.patch("billingCustomers", customer._id, { unresolvedReceipts: customer.unresolvedReceipts - 1, inputRevision: customer.inputRevision + 1 });
        await scheduleCustomer(ctx, customer._id);
      }
      await ctx.db.patch("billingEvents", eventRef, { state: "processed" });
    }
    await ctx.db.patch("billingEvents", eventRef, { resolution: { ...resolution, previous } });
    console.info("[billingOperator] resolved", { eventRef });
    return null;
  },
});

export const placeSupportHold = internalMutation({
  args: { customerRef: v.id("billingCustomers"), ...auditArgs },
  returns: v.id("billingAdjustments"),
  handler: async (ctx, { customerRef, operator, reason }) => {
    const placedBy = audit("placeSupportHold", operator, reason);
    const customer = await ctx.db.get("billingCustomers", customerRef);
    if (!customer) throw appError("NOT_FOUND", "Customer not found");
    const ref = await ctx.db.insert("billingAdjustments", {
      customerRef, mode: customer.mode, kind: "support_hold", providerId: "support:" + crypto.randomUUID(),
      paymentId: "", status: "active", countedMinor: 0, holdActive: true, observedAt: placedBy.at,
      placedBy: { ...placedBy, previous: { holdActive: false } },
    });
    await ctx.db.patch("billingCustomers", customerRef, { inputRevision: customer.inputRevision + 1 });
    console.info("[billingOperator] hold placed", { customerRef, adjustmentRef: ref });
    return ref;
  },
});

export const releaseHold = internalMutation({
  args: { adjustmentRef: v.id("billingAdjustments"), ...auditArgs },
  returns: v.null(),
  handler: async (ctx, { adjustmentRef, operator, reason }) => {
    const releasedBy = audit("releaseHold", operator, reason);
    const row = await ctx.db.get("billingAdjustments", adjustmentRef);
    if (!row) throw appError("NOT_FOUND", "Hold not found");
    const customer = await ctx.db.get("billingCustomers", row.customerRef);
    if (!customer || customer.mode !== row.mode) throw appError("CONFLICT", "Hold owner mode differs");
    if (row.kind !== "support_hold" && (row.kind !== "dispute" || !["expired", "other"].includes(row.status))) {
      throw appError("INVALID_ARGUMENT", "Hold needs provider resolution");
    }
    if (!row.holdActive) return null;
    await ctx.db.patch("billingAdjustments", adjustmentRef, {
      holdActive: false, ...(row.kind === "dispute" ? { holdOverrideStatus: row.status } : {}),
      releasedBy: { ...releasedBy, previous: { holdActive: row.holdActive, status: row.status } },
    });
    await ctx.db.patch("billingCustomers", customer._id, { inputRevision: customer.inputRevision + 1 });
    console.info("[billingOperator] hold released", { adjustmentRef });
    return null;
  },
});

/** amountMinor is the reviewed cumulative amount for the whole payment, or null for no reversal. */
export const resolveUnreadableReversal = internalMutation({
  args: {
    customerRef: v.id("billingCustomers"), eventRef: v.id("billingEvents"),
    generation: v.number(), inputRevision: v.number(), amountMinor: v.union(v.number(), v.null()), ...auditArgs,
  },
  returns: v.null(),
  handler: async (ctx, { customerRef, eventRef, generation, inputRevision, amountMinor, operator, reason }) => {
    const resolution = audit("resolveUnreadableReversal", operator, reason);
    const customer = await ctx.db.get("billingCustomers", customerRef);
    const row = await ctx.db.get("billingEvents", eventRef);
    if (!customer || !row) throw appError("NOT_FOUND", "Customer or receipt not found");
    if (customer.generation !== generation || customer.inputRevision !== inputRevision) throw appError("CONFLICT", "Customer fence changed");
    if (row.customerRef !== customerRef || row.mode !== customer.mode || !negative(row.eventType) ||
      row.state !== "quarantined" || !["retries_exhausted", "unsupported"].includes(row.quarantineReason ?? "") || !row.paymentId) {
      throw appError("INVALID_ARGUMENT", "Receipt must be an owned dead-lettered reversal");
    }
    const purchase = await ctx.db.query("billingPurchases")
      .withIndex("by_mode_and_paymentId", q => q.eq("mode", customer.mode).eq("paymentId", row.paymentId)).unique();
    if (!purchase || purchase.customerRef !== customerRef || !Number.isSafeInteger(purchase.totalMinor) || purchase.totalMinor! <= 0) {
      throw appError("INVALID_ARGUMENT", "Payment needs an owned purchase with a known gross total");
    }
    if (amountMinor !== null && (!Number.isSafeInteger(amountMinor) || amountMinor < 0 || amountMinor > purchase.totalMinor!)) {
      throw appError("INVALID_ARGUMENT", "Amount must be within the payment gross total");
    }
    if (amountMinor !== null) {
      await applyPurchaseReversal(ctx, customer, purchase, amountMinor, purchase.totalMinor!, await ownerDeleted(ctx, customer));
    }
    await ctx.db.patch("billingEvents", eventRef, {
      state: "processed", reviewedReversalMinor: amountMinor ?? 0,
      resolution: { ...resolution, previous: { state: row.state, customerRef, quarantineReason: row.quarantineReason, reversedMinor: purchase.reversedMinor ?? 0 } },
    });
    await ctx.db.patch("billingCustomers", customerRef, { unresolvedReceipts: customer.unresolvedReceipts - 1, inputRevision: customer.inputRevision + 1 });
    await queuePaymentRead(ctx, customerRef, row.paymentId, resolution.at);
    await scheduleCustomer(ctx, customerRef);
    console.info("[billingOperator] reversal resolved", { customerRef, eventRef, purchaseRef: purchase._id });
    return null;
  },
});
