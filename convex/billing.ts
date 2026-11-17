import { v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { appError } from "./errors";
import { billingModeValidator, billingPurchaseTermsValidator, billingResourceIdsValidator } from "./schema";

const identityFields = { ownerTokenIdentifier: v.string(), userId: v.string() };
const fenceValidator = v.object({ generation: v.number(), inputRevision: v.number() });
const conflict = () => appError("CONFLICT", "Billing binding conflicts with durable state");
const requireText = (value: string) => {
  if (!value.trim()) throw appError("INVALID_ARGUMENT", "Billing identifiers must be nonempty");
};
const getUser = (ctx: QueryCtx, userId: string) => ctx.db.query("users")
  .withIndex("by_clerkUserId", q => q.eq("clerkUserId", userId)).unique();

async function requireCustomer(ctx: QueryCtx, customerRef: Id<"billingCustomers">) {
  const customer = await ctx.db.get("billingCustomers", customerRef);
  if (!customer) throw appError("NOT_FOUND", "Billing customer not found");
  return customer;
}

async function requireActiveOwner(ctx: QueryCtx, customer: Pick<Doc<"billingCustomers">, "userId" | "deletedAt" | "hold">) {
  const user = await getUser(ctx, customer.userId);
  if (!user || user.deletedAt !== undefined || customer.deletedAt !== undefined || customer.hold) {
    throw appError("FORBIDDEN", "Billing owner is unavailable");
  }
}

// Only trusted internal callers pass normalized, verified Clerk tokenIdentifier + subject.
export const ensureCustomer = internalMutation({
  args: { mode: billingModeValidator, ...identityFields },
  returns: v.id("billingCustomers"),
  handler: async (ctx, args) => {
    requireText(args.ownerTokenIdentifier);
    requireText(args.userId);
    await requireActiveOwner(ctx, args);
    const existing = await ctx.db.query("billingCustomers")
      .withIndex("by_mode_and_ownerTokenIdentifier", q => q.eq("mode", args.mode).eq("ownerTokenIdentifier", args.ownerTokenIdentifier)).unique();
    const bySubject = await ctx.db.query("billingCustomers")
      .withIndex("by_mode_and_userId", q => q.eq("mode", args.mode).eq("userId", args.userId)).unique();
    if (existing) {
      if (existing.userId !== args.userId || bySubject?._id !== existing._id) throw conflict();
      await requireActiveOwner(ctx, existing);
      return existing._id;
    }
    if (bySubject) throw conflict();
    return await ctx.db.insert("billingCustomers", {
      ...args, creationState: "preparing", generation: 0, inputRevision: 0, unresolvedReceipts: 0,
    });
  },
});

export const bindCustomer = internalMutation({
  args: { customerRef: v.id("billingCustomers"), customerId: v.string() },
  returns: v.null(),
  handler: async (ctx, { customerRef, customerId }) => {
    requireText(customerId);
    const customer = await requireCustomer(ctx, customerRef);
    await requireActiveOwner(ctx, customer);
    const existing = await ctx.db.query("billingCustomers")
      .withIndex("by_mode_and_customerId", q => q.eq("mode", customer.mode).eq("customerId", customerId)).unique();
    if ((existing && existing._id !== customerRef) || (customer.customerId && customer.customerId !== customerId)) throw conflict();
    await ctx.db.patch("billingCustomers", customerRef, { customerId, creationState: "ready" });
    return null;
  },
});

export const reservePurchase = internalMutation({
  args: { customerRef: v.id("billingCustomers"), intentId: v.string(), terms: billingPurchaseTermsValidator },
  returns: v.id("billingPurchases"),
  handler: async (ctx, args) => {
    requireText(args.intentId);
    requireText(args.terms.productId);
    requireText(args.terms.catalogVersion);
    if (![args.terms.quantity, args.terms.credits].every(n => Number.isSafeInteger(n) && n > 0)) {
      throw appError("INVALID_ARGUMENT", "Purchase quantity and credits must be positive integers");
    }
    const customer = await requireCustomer(ctx, args.customerRef);
    await requireActiveOwner(ctx, customer);
    if (customer.creationState !== "ready" || !customer.customerId) throw conflict();
    const existing = await ctx.db.query("billingPurchases")
      .withIndex("by_mode_and_intentId", q => q.eq("mode", customer.mode).eq("intentId", args.intentId)).unique();
    if (existing) {
      if (existing.customerRef !== args.customerRef || Object.entries(args.terms)
        .some(([key, value]) => existing.terms[key as keyof typeof args.terms] !== value)) throw conflict();
      return existing._id;
    }
    // Unknown outcomes keep this lock; time alone never authorizes a second checkout.
    if (customer.pendingPurchaseRef) throw conflict();
    const purchaseRef = await ctx.db.insert("billingPurchases", { ...args, mode: customer.mode, state: "preparing" });
    await ctx.db.patch("billingCustomers", customer._id, { pendingPurchaseRef: purchaseRef });
    return purchaseRef;
  },
});

export const bindSubscription = internalMutation({
  args: { customerRef: v.id("billingCustomers"), subscriptionId: v.string(), productId: v.string() },
  returns: v.id("billingSubscriptions"),
  handler: async (ctx, args) => {
    requireText(args.subscriptionId);
    requireText(args.productId);
    const customer = await requireCustomer(ctx, args.customerRef);
    const existing = await ctx.db.query("billingSubscriptions")
      .withIndex("by_mode_and_subscriptionId", q => q.eq("mode", customer.mode).eq("subscriptionId", args.subscriptionId)).unique();
    if (existing) {
      if (existing.customerRef !== args.customerRef || existing.productId !== args.productId) throw conflict();
      return existing._id;
    }
    return await ctx.db.insert("billingSubscriptions", { ...args, mode: customer.mode, status: "pending" });
  },
});

export const bindPurchase = internalMutation({
  args: { purchaseRef: v.id("billingPurchases"), ...billingResourceIdsValidator.fields, expiresAt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { purchaseRef, ...ids }) => {
    const purchase = await ctx.db.get("billingPurchases", purchaseRef);
    if (!purchase) throw appError("NOT_FOUND", "Billing purchase not found");
    const customer = await requireCustomer(ctx, purchase.customerRef);
    for (const field of ["sessionId", "paymentId", "subscriptionId", "expiresAt"] as const) {
      const value = ids[field];
      if (value === undefined) continue;
      if (typeof value === "string") requireText(value);
      else if (!Number.isFinite(value)) throw appError("INVALID_ARGUMENT", "Invalid checkout expiry");
      if (purchase[field] !== undefined && purchase[field] !== value) throw conflict();
    }
    for (const field of ["sessionId", "paymentId"] as const) {
      const value = ids[field];
      if (value === undefined) continue;
      const existing = await ctx.db.query("billingPurchases")
        .withIndex(field === "sessionId" ? "by_mode_and_sessionId" : "by_mode_and_paymentId", q => q.eq("mode", purchase.mode).eq(field, value)).unique();
      if (existing && existing._id !== purchaseRef) throw conflict();
    }
    if (ids.subscriptionId !== undefined) {
      const subscription = await ctx.db.query("billingSubscriptions")
        .withIndex("by_mode_and_subscriptionId", q => q.eq("mode", purchase.mode).eq("subscriptionId", ids.subscriptionId!)).unique();
      if (!subscription || subscription.customerRef !== customer._id || subscription.productId !== purchase.terms.productId) throw conflict();
    }
    const user = await getUser(ctx, customer.userId);
    await ctx.db.patch("billingPurchases", purchaseRef, {
      ...ids,
      ...(!user || user.deletedAt !== undefined || customer.deletedAt !== undefined ? { cancellationRecoveryRequired: true } : {}),
    });
    return null;
  },
});

export const recordReceipt = internalMutation({
  args: {
    customerRef: v.id("billingCustomers"), webhookId: v.string(), eventType: v.string(),
    bodyDigest: v.string(), occurredAt: v.number(), ...billingResourceIdsValidator.fields,
  },
  returns: v.id("billingEvents"),
  handler: async (ctx, args) => {
    requireText(args.webhookId);
    requireText(args.eventType);
    if (!/^[a-f0-9]{64}$/.test(args.bodyDigest) || !Number.isFinite(args.occurredAt)) {
      throw appError("INVALID_ARGUMENT", "Invalid normalized billing receipt");
    }
    const parent = await requireCustomer(ctx, args.customerRef);
    const existing = await ctx.db.query("billingEvents")
      .withIndex("by_mode_and_webhookId", q => q.eq("mode", parent.mode).eq("webhookId", args.webhookId)).unique();
    if (existing) {
      if (existing.bodyDigest !== args.bodyDigest && existing.state !== "quarantined") {
        const originalParent = await requireCustomer(ctx, existing.customerRef);
        await ctx.db.patch("billingEvents", existing._id, { state: "quarantined" });
        await ctx.db.patch("billingCustomers", originalParent._id, {
          inputRevision: originalParent.inputRevision + 1,
          unresolvedReceipts: originalParent.unresolvedReceipts + (existing.state === "processed" || existing.state === "ignored" ? 1 : 0),
        });
      }
      return existing._id;
    }
    const now = Date.now();
    const eventRef = await ctx.db.insert("billingEvents", {
      ...args, mode: parent.mode, receivedAt: now, state: "pending", attempts: 0,
      nextAttemptAt: now, generation: parent.generation,
    });
    await ctx.db.patch("billingCustomers", parent._id, { inputRevision: parent.inputRevision + 1, unresolvedReceipts: parent.unresolvedReceipts + 1 });
    return eventRef;
  },
});

export const getFence = internalQuery({
  args: { customerRef: v.id("billingCustomers") },
  returns: fenceValidator,
  handler: async (ctx, { customerRef }) => {
    const customer = await requireCustomer(ctx, customerRef);
    return { generation: customer.generation, inputRevision: customer.inputRevision };
  },
});

// Future positive financial commits must call this inside the committing mutation.
export async function assertBillingFence(ctx: QueryCtx, customerRef: Id<"billingCustomers">, captured: Infer<typeof fenceValidator>) {
  const customer = await requireCustomer(ctx, customerRef);
  await requireActiveOwner(ctx, customer);
  if (customer.generation !== captured.generation || customer.inputRevision !== captured.inputRevision || customer.unresolvedReceipts !== 0) throw conflict();
}
