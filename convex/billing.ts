import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { scheduleCustomer } from "./billingQueue";
import { hasActiveHold } from "./billingReversals";
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

export async function requireActiveOwner(ctx: QueryCtx, customer: Pick<Doc<"billingCustomers">, "userId" | "deletedAt" | "hold">) {
  if (customer.hold || await ownerDeleted(ctx, customer)) throw appError("FORBIDDEN", "Billing owner is unavailable");
}

const requireMode = (actual: Doc<"billingCustomers">["mode"], expected: Doc<"billingCustomers">["mode"]) => {
  if (actual !== expected) throw conflict();
};

const ensureCustomerArgs = v.object({ mode: billingModeValidator, ...identityFields });

/** Shared by `ensureCustomer` and checkout: the owner's one customer row in `mode`, created `preparing`. */
export async function ensureCustomerRow(ctx: MutationCtx, args: Infer<typeof ensureCustomerArgs>) {
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
}

// Only trusted internal callers pass normalized, verified Clerk tokenIdentifier + subject.
export const ensureCustomer = internalMutation({
  args: ensureCustomerArgs,
  returns: v.id("billingCustomers"),
  handler: ensureCustomerRow,
});

const bindCustomerArgs = v.object({ customerRef: v.id("billingCustomers"), customerId: v.string() });

/** Shared by `bindCustomer` and checkout; throws CONFLICT when the ID belongs to another customer row. */
export async function bindCustomerRow(ctx: MutationCtx, { customerRef, customerId }: Infer<typeof bindCustomerArgs>) {
  requireText(customerId);
  const customer = await requireCustomer(ctx, customerRef);
  const existing = await ctx.db.query("billingCustomers")
    .withIndex("by_mode_and_customerId", q => q.eq("mode", customer.mode).eq("customerId", customerId)).unique();
  if ((existing && existing._id !== customerRef) || (customer.customerId && customer.customerId !== customerId)) throw conflict();
  // A late ID for a deleted or held owner is kept for recovery but never reopens the customer.
  const live = !customer.hold && !(await ownerDeleted(ctx, customer));
  await ctx.db.patch("billingCustomers", customerRef, live ? { customerId, creationState: "ready" } : { customerId });
  // Also for a deleted or held owner: its early receipts still need processing for suppression and recovery.
  await associateUnmappedReceipts(ctx, customer, { providerCustomerId: customerId });
  return null;
}

export const bindCustomer = internalMutation({
  args: bindCustomerArgs,
  returns: v.null(),
  handler: bindCustomerRow,
});

const reservePurchaseArgs = v.object({ customerRef: v.id("billingCustomers"), intentId: v.string(), terms: billingPurchaseTermsValidator });

/** Shared by `reservePurchase` and checkout; refuses (CONFLICT) while the one-checkout lock is held. */
export async function reservePurchaseRow(ctx: MutationCtx, args: Infer<typeof reservePurchaseArgs>) {
  requireText(args.intentId);
  requireText(args.terms.productId);
  requireText(args.terms.catalogVersion);
  if (![args.terms.quantity, args.terms.credits].every(n => Number.isSafeInteger(n) && n > 0)) {
    throw appError("INVALID_ARGUMENT", "Purchase quantity and credits must be positive integers");
  }
  const customer = await requireCustomer(ctx, args.customerRef);
  await requireActiveOwner(ctx, customer);
  // A dispute or support hold refuses new checkouts; it never blocks grants of settled money.
  if (await hasActiveHold(ctx, customer._id)) throw appError("FORBIDDEN", "Billing is on hold");
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
}

export const reservePurchase = internalMutation({
  args: reservePurchaseArgs,
  returns: v.id("billingPurchases"),
  handler: reservePurchaseRow,
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

const bindPurchaseArgs = v.object({
  purchaseRef: v.id("billingPurchases"), mode: billingModeValidator, ...billingResourceIdsValidator.fields, expiresAt: v.optional(v.number()),
});

/** Shared by `bindPurchase` and checkout; each provider ID is unique per mode and never changes once set. */
export async function bindPurchaseRow(ctx: MutationCtx, { purchaseRef, mode, ...ids }: Infer<typeof bindPurchaseArgs>) {
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
  if (ids.paymentId !== undefined) await associateUnmappedReceipts(ctx, customer, { paymentId: ids.paymentId });
  return null;
}

export const bindPurchase = internalMutation({
  args: bindPurchaseArgs,
  returns: v.null(),
  handler: bindPurchaseRow,
});

/**
 * Maps a receipt in the receiving transaction, so a binding that commits concurrently is never
 * missed: by the payload's provider customer, else (no customer in the payload) by the purchase
 * our own settlement or checkout already bound to its payment.
 */
async function receiptParent(ctx: QueryCtx, mode: Doc<"billingCustomers">["mode"], providerCustomerId?: string, paymentId?: string) {
  if (providerCustomerId !== undefined) {
    return await ctx.db.query("billingCustomers")
      .withIndex("by_mode_and_customerId", q => q.eq("mode", mode).eq("customerId", providerCustomerId)).unique();
  }
  if (paymentId === undefined) return null;
  const purchase = await ctx.db.query("billingPurchases")
    .withIndex("by_mode_and_paymentId", q => q.eq("mode", mode).eq("paymentId", paymentId)).unique();
  return purchase && await ctx.db.get("billingCustomers", purchase.customerRef);
}

export const recordReceipt = internalMutation({
  args: {
    customerRef: v.optional(v.id("billingCustomers")), mode: billingModeValidator, webhookId: v.string(), eventType: v.string(),
    bodyDigest: v.string(), occurredAt: v.number(), ...billingResourceIdsValidator.fields,
    // The payload's provider customer: mapped here, else stored on the unmapped receipt for a later binding.
    providerCustomerId: v.optional(v.string()),
    // Authenticated but unsupported event types: stored for dedupe, never processed or counted.
    ignored: v.optional(v.boolean()),
  },
  returns: v.id("billingEvents"),
  handler: async (ctx, { ignored, providerCustomerId, customerRef, ...args }) => {
    requireText(args.webhookId);
    requireText(args.eventType);
    if (!/^[a-f0-9]{64}$/.test(args.bodyDigest) || !Number.isFinite(args.occurredAt)) {
      throw appError("INVALID_ARGUMENT", "Invalid normalized billing receipt");
    }
    const parent = customerRef !== undefined ? await requireCustomer(ctx, customerRef)
      : await receiptParent(ctx, args.mode, providerCustomerId, args.paymentId);
    if (parent) requireMode(parent.mode, args.mode);
    const existing = await ctx.db.query("billingEvents")
      .withIndex("by_mode_and_webhookId", q => q.eq("mode", args.mode).eq("webhookId", args.webhookId)).unique();
    if (existing) {
      const unmapped = existing.state === "quarantined" && existing.customerRef === undefined;
      if (unmapped) {
        // A replay after mapping (same digest) attaches the row; a differing one stays unmapped for an operator.
        if (existing.bodyDigest !== args.bodyDigest) {
          if (existing.quarantineReason !== "digest_mismatch") await ctx.db.patch("billingEvents", existing._id, { quarantineReason: "digest_mismatch" });
        } else if (parent) {
          await attachReceipts(ctx, parent._id, [existing]);
        }
      } else if (existing.bodyDigest !== args.bodyDigest && existing.state !== "quarantined") {
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
      ...args, ...(parent ? { customerRef: parent._id } : {}), receivedAt: now, state: ignored ? "ignored" : parent ? "pending" : "quarantined", attempts: 0,
      nextAttemptAt: now, generation: parent?.generation ?? 0,
      ...(parent || ignored ? {} : { quarantineReason: "unmapped" as const, ...(providerCustomerId ? { providerCustomerId } : {}) }),
    });
    if (parent && !ignored) {
      await ctx.db.patch("billingCustomers", parent._id, { inputRevision: parent.inputRevision + 1, unresolvedReceipts: parent.unresolvedReceipts + 1 });
      await scheduleCustomer(ctx, parent._id);
    }
    return eventRef;
  },
});

export const MAX_ASSOCIATE_BATCH = 50;
const associateByValidator = v.union(v.object({ providerCustomerId: v.string() }), v.object({ paymentId: v.string() }));
type AssociateBy = Infer<typeof associateByValidator>;

/**
 * Attaches unmapped quarantined receipts to the customer. An unmapped row becomes pending; a
 * digest_mismatch row stays quarantined for an operator. Both are counted for support, and an
 * attached refund or dispute fences the customer's grants. A row whose stored provider customer
 * differs from the customer's never attaches.
 */
async function attachReceipts(ctx: MutationCtx, customerRef: Id<"billingCustomers">, rows: Doc<"billingEvents">[]) {
  // Re-read: callers such as bindCustomer may have just patched the customer.
  const customer = await requireCustomer(ctx, customerRef);
  const owned = rows.filter(row => row.customerRef === undefined && row.state === "quarantined" && row.mode === customer.mode &&
    (row.providerCustomerId === undefined || row.providerCustomerId === customer.customerId));
  if (!owned.length) return 0;
  const now = Date.now();
  let pending = 0;
  for (const row of owned) {
    const retry = row.quarantineReason === "unmapped";
    if (retry) pending += 1;
    await ctx.db.patch("billingEvents", row._id, {
      customerRef, ...(retry ? { state: "pending" as const, quarantineReason: undefined, attempts: 0, nextAttemptAt: now } : {}),
    });
  }
  await ctx.db.patch("billingCustomers", customerRef, {
    inputRevision: customer.inputRevision + 1, unresolvedReceipts: customer.unresolvedReceipts + owned.length,
  });
  if (pending) await scheduleCustomer(ctx, customerRef);
  console.info("[billing] associated unmapped receipts", { customerRef, attached: owned.length, pending });
  return owned.length;
}

const quarantinedBy = (ctx: QueryCtx, mode: Doc<"billingCustomers">["mode"], by: AssociateBy) => "paymentId" in by
  ? ctx.db.query("billingEvents").withIndex("by_mode_and_paymentId_and_state", q => q.eq("mode", mode).eq("paymentId", by.paymentId).eq("state", "quarantined"))
  : ctx.db.query("billingEvents").withIndex("by_mode_and_providerCustomerId_and_state", q => q.eq("mode", mode).eq("providerCustomerId", by.providerCustomerId).eq("state", "quarantined"));

/**
 * Attaches unmapped quarantined receipts found by a trusted key (our own customer or purchase
 * binding, never metadata or email) to `customer`. Returns how many. A full batch hands the rest
 * to `associateMoreUnmapped`, which pages through the range so skipped rows never stall it.
 */
export async function associateUnmappedReceipts(ctx: MutationCtx, customer: Doc<"billingCustomers">, by: AssociateBy): Promise<number> {
  const rows = await quarantinedBy(ctx, customer.mode, by).take(MAX_ASSOCIATE_BATCH);
  if (rows.length === MAX_ASSOCIATE_BATCH) {
    await ctx.scheduler.runAfter(0, internal.billing.associateMoreUnmapped, { customerRef: customer._id, by, cursor: null });
  }
  return await attachReceipts(ctx, customer._id, rows);
}

// Its own mutation, so it may page (one paginated query per function); the range is fixed per `by`.
export const associateMoreUnmapped = internalMutation({
  args: { customerRef: v.id("billingCustomers"), by: associateByValidator, cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { customerRef, by, cursor }) => {
    const customer = await ctx.db.get("billingCustomers", customerRef);
    if (!customer) return null;
    const { page, isDone, continueCursor } = await quarantinedBy(ctx, customer.mode, by).paginate({ cursor, numItems: MAX_ASSOCIATE_BATCH });
    await attachReceipts(ctx, customerRef, page);
    if (!isDone) await ctx.scheduler.runAfter(0, internal.billing.associateMoreUnmapped, { customerRef, by, cursor: continueCursor });
    return null;
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
