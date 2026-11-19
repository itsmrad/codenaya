import { v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { scheduleCustomer } from "./billingQueue";
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

export async function ownerDeleted(ctx: QueryCtx, customer: Pick<Doc<"billingCustomers">, "userId" | "deletedAt">) {
  const user = await getUser(ctx, customer.userId);
  return !user || user.deletedAt !== undefined || customer.deletedAt !== undefined;
}

async function requireActiveOwner(ctx: QueryCtx, customer: Pick<Doc<"billingCustomers">, "userId" | "deletedAt" | "hold">) {
  if (customer.hold || await ownerDeleted(ctx, customer)) throw appError("FORBIDDEN", "Billing owner is unavailable");
}

const requireMode = (actual: Doc<"billingCustomers">["mode"], expected: Doc<"billingCustomers">["mode"]) => {
  if (actual !== expected) throw conflict();
};

// Only trusted internal callers pass normalized, verified Clerk tokenIdentifier + subject.
export const ensureCustomer = internalMutation({
  args: { mode: billingModeValidator, ...identityFields },
  returns: v.id("billingCustomers"),
  handler: async (ctx, args) => {
    requireText(args.ownerTokenIdentifier);
    requireText(args.userId);
    if (!args.ownerTokenIdentifier.endsWith(`|${args.userId}`)) {
      throw appError("INVALID_ARGUMENT", "Billing owner token does not match its subject");
    }
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
    const existing = await ctx.db.query("billingCustomers")
      .withIndex("by_mode_and_customerId", q => q.eq("mode", customer.mode).eq("customerId", customerId)).unique();
    if ((existing && existing._id !== customerRef) || (customer.customerId && customer.customerId !== customerId)) throw conflict();
    // A late ID for a deleted or held owner is kept for recovery but never reopens the customer.
    const live = !customer.hold && !(await ownerDeleted(ctx, customer));
    await ctx.db.patch("billingCustomers", customerRef, live ? { customerId, creationState: "ready" } : { customerId });
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

const bindSubscriptionArgs = v.object({ customerRef: v.id("billingCustomers"), mode: billingModeValidator, subscriptionId: v.string(), productId: v.string() });

/** Shared by `bindSubscription` and fulfillment; throws CONFLICT for another customer's or product's row. */
export async function bindSubscriptionRow(ctx: MutationCtx, args: Infer<typeof bindSubscriptionArgs>) {
  requireText(args.subscriptionId);
  requireText(args.productId);
  const customer = await requireCustomer(ctx, args.customerRef);
  requireMode(customer.mode, args.mode);
  const late = await ownerDeleted(ctx, customer);
  const existing = await ctx.db.query("billingSubscriptions")
    .withIndex("by_mode_and_subscriptionId", q => q.eq("mode", args.mode).eq("subscriptionId", args.subscriptionId)).unique();
  if (existing) {
    if (existing.customerRef !== args.customerRef || existing.productId !== args.productId) throw conflict();
    if (late) await ctx.db.patch("billingSubscriptions", existing._id, { cancellationRecoveryRequired: true });
    return existing._id;
  }
  return await ctx.db.insert("billingSubscriptions", { ...args, status: "pending", ...(late ? { cancellationRecoveryRequired: true } : {}) });
}

export const bindSubscription = internalMutation({
  args: bindSubscriptionArgs,
  returns: v.id("billingSubscriptions"),
  handler: bindSubscriptionRow,
});

export const bindPurchase = internalMutation({
  args: { purchaseRef: v.id("billingPurchases"), mode: billingModeValidator, ...billingResourceIdsValidator.fields, expiresAt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { purchaseRef, mode, ...ids }) => {
    const purchase = await ctx.db.get("billingPurchases", purchaseRef);
    if (!purchase) throw appError("NOT_FOUND", "Billing purchase not found");
    requireMode(purchase.mode, mode);
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
    await ctx.db.patch("billingPurchases", purchaseRef, {
      ...ids,
      ...(await ownerDeleted(ctx, customer) ? { cancellationRecoveryRequired: true } : {}),
    });
    return null;
  },
});

export const recordReceipt = internalMutation({
  args: {
    customerRef: v.optional(v.id("billingCustomers")), mode: billingModeValidator, webhookId: v.string(), eventType: v.string(),
    bodyDigest: v.string(), occurredAt: v.number(), ...billingResourceIdsValidator.fields,
    // Authenticated but unsupported event types: stored for dedupe, never processed or counted.
    ignored: v.optional(v.boolean()),
  },
  returns: v.id("billingEvents"),
  handler: async (ctx, { ignored, ...args }) => {
    requireText(args.webhookId);
    requireText(args.eventType);
    if (!/^[a-f0-9]{64}$/.test(args.bodyDigest) || !Number.isFinite(args.occurredAt)) {
      throw appError("INVALID_ARGUMENT", "Invalid normalized billing receipt");
    }
    const parent = args.customerRef === undefined ? null : await requireCustomer(ctx, args.customerRef);
    if (parent) requireMode(parent.mode, args.mode);
    const existing = await ctx.db.query("billingEvents")
      .withIndex("by_mode_and_webhookId", q => q.eq("mode", args.mode).eq("webhookId", args.webhookId)).unique();
    if (existing) {
      if (existing.bodyDigest !== args.bodyDigest && existing.state !== "quarantined") {
        await ctx.db.patch("billingEvents", existing._id, { state: "quarantined", quarantineReason: "digest_mismatch" });
        if (existing.customerRef) {
          const originalParent = await requireCustomer(ctx, existing.customerRef);
          await ctx.db.patch("billingCustomers", originalParent._id, {
            inputRevision: originalParent.inputRevision + 1,
            unresolvedReceipts: originalParent.unresolvedReceipts + (existing.state === "processed" || existing.state === "ignored" ? 1 : 0),
          });
        }
      }
      return existing._id;
    }
    const now = Date.now();
    // An unmapped verified receipt is never discarded: it waits quarantined for reconciliation.
    const eventRef = await ctx.db.insert("billingEvents", {
      ...args, receivedAt: now, state: ignored ? "ignored" : parent ? "pending" : "quarantined", attempts: 0,
      nextAttemptAt: now, generation: parent?.generation ?? 0, ...(parent || ignored ? {} : { quarantineReason: "unmapped" as const }),
    });
    if (parent && !ignored) {
      await ctx.db.patch("billingCustomers", parent._id, { inputRevision: parent.inputRevision + 1, unresolvedReceipts: parent.unresolvedReceipts + 1 });
      await scheduleCustomer(ctx, parent._id);
    }
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

/**
 * A grant's fence inside the committing mutation: unchanged generation and revision, and an
 * owner neither held nor deleted. Fulfillment checks unresolved negatives itself, so pending
 * positives left for later claims never block a grant.
 */
export async function assertGrantFence(ctx: QueryCtx, customerRef: Id<"billingCustomers">, captured: Infer<typeof fenceValidator>) {
  const customer = await requireCustomer(ctx, customerRef);
  await requireActiveOwner(ctx, customer);
  if (customer.generation !== captured.generation || customer.inputRevision !== captured.inputRevision) throw conflict();
  return customer;
}

/** The grant fence plus no unresolved receipt at all. */
export async function assertBillingFence(ctx: QueryCtx, customerRef: Id<"billingCustomers">, captured: Infer<typeof fenceValidator>) {
  if ((await assertGrantFence(ctx, customerRef, captured)).unresolvedReceipts !== 0) throw conflict();
}
