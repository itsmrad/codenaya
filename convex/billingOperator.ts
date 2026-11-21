import { v } from "convex/values";

import { internalMutation } from "./_generated/server";
import { bindCustomerRow } from "./billing";
import { CHECKOUT_PREPARE_STALE_MS } from "./billingCheckout";
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
    await ctx.db.patch("billingCustomers", customerRef, {
      creationLeaseId: undefined, creationLeasedAt: undefined,
      resolution: { ...resolution, previousState: customer.creationState },
    });
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
      purchase.state === "settled" || purchase.state === "processing" || purchase.paymentId !== undefined ||
      (purchase.state === "preparing" && resolution.at - purchase._creationTime < CHECKOUT_PREPARE_STALE_MS)) {
      throw appError("INVALID_ARGUMENT", "Checkout cannot be released");
    }
    // Keep the session id: a late payment must still settle through the normal fenced path.
    await ctx.db.patch("billingPurchases", purchase._id, { state: "terminal", resolution: { ...resolution, previousState: purchase.state } });
    await ctx.db.patch("billingCustomers", customerRef, { pendingPurchaseRef: undefined });
    console.info("[billingOperator] resolved", { action: resolution.action, customerRef, purchaseRef: purchase._id, operator });
    return null;
  },
});
