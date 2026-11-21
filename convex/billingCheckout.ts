import type { UserIdentity } from "convex/server";
import { v } from "convex/values";

import { isDodoCheckoutUrl } from "../src/features/billing/checkout-url";
import { isInPaidPeriod } from "../src/features/billing/grants";
import { PLANS, TOP_UP } from "../src/features/billing/plans";
import { BILLING_CATALOG_VERSION } from "../src/features/billing/settlement";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, type MutationCtx } from "./_generated/server";
import { verifyAuth } from "./auth";
import { bindCustomerRow, bindPurchaseRow, ensureCustomerRow, reservePurchaseRow } from "./billing";
import { readConvexBillingConfig } from "./billingEnv";
import { MAX_SUBSCRIPTIONS_PER_STATUS } from "./billingFulfill";
import { countActiveLots, MAX_ACTIVE_LOTS, readPeriodLots } from "./billingGrants";
import { markPollDue } from "./billingPoll";
import { hasActiveHold } from "./billingReversals";
import { appError } from "./errors";
import { validateInternalKey } from "./internalKey";
import { billingModeValidator } from "./schema";

/**
 * Server-only checkout bridge (stage 9, docs/billing-stage9.md). Next calls these as the
 * signed-in user (Clerk Convex JWT) with the internal key; the owner always comes from the
 * JWT. Nothing here calls the provider: Next creates the customer or checkout and records
 * the result. A business refusal is a return value, so earlier writes in the call commit.
 */

export const CUSTOMER_LEASE_STALE_MS = 2 * 60_000;
export const CHECKOUT_PREPARE_STALE_MS = 2 * 60_000;
// Same pattern as the reconciler's provider reads; anything else is treated as a lost response.
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,128}$/;
// Any row in these states needs recovery or support, never a second subscription.
const SUBSCRIBED = new Set<Doc<"billingSubscriptions">["status"]>(["pending", "active", "quarantined"]);
const SUBSCRIPTION_STATUSES = ["pending", "active", "quarantined", "cancelled", "expired"] as const;

const skuValidator = v.union(v.literal("pro_monthly"), v.literal("top_up"));
type Sku = Doc<"billingPurchases">["terms"]["sku"];
type Mode = Doc<"billingCustomers">["mode"];
// A definite 4xx answer: nothing was created.
const notCreated = v.object({ kind: v.literal("not_created") });
// Lost response (timeout, network, 5xx, 408/409/429): something may have been created.
const unknownOutcome = v.object({ kind: v.literal("unknown") });

const conflict = () => appError("CONFLICT", "Checkout state changed; try again");
const notFound = () => appError("NOT_FOUND", "Billing record not found");

async function authorize(ctx: MutationCtx, internalKey: string) {
  validateInternalKey(internalKey);
  return await verifyAuth(ctx);
}

/** The caller's own customer row; another owner's ref is indistinguishable from a missing one. */
async function ownedCustomer(ctx: MutationCtx, identity: UserIdentity, customerRef: Id<"billingCustomers">) {
  const customer = await ctx.db.get("billingCustomers", customerRef);
  if (!customer || customer.ownerTokenIdentifier !== identity.tokenIdentifier || customer.userId !== identity.subject) throw notFound();
  return customer;
}

/** Convex's own catalog must agree with Next's mode and product, or settlement would quarantine the purchase. */
function catalogMatches(mode: Mode, sku: Sku, productId: string) {
  const config = readConvexBillingConfig("convex-reconciler");
  const product = sku === "pro_monthly" ? config?.proProductId : config?.topUpProductId;
  return config !== null && config.environment === mode && product !== undefined && product === productId;
}

/** Any subscription that is live, pending, quarantined or still paid through now. Fails closed past the read bound. */
async function hasSubscription(ctx: MutationCtx, customerRef: Id<"billingCustomers">, now: number) {
  for (const status of SUBSCRIPTION_STATUSES) {
    const rows = await ctx.db.query("billingSubscriptions")
      .withIndex("by_customerRef_and_status", q => q.eq("customerRef", customerRef).eq("status", status))
      .take(MAX_SUBSCRIPTIONS_PER_STATUS + 1);
    if (rows.length > MAX_SUBSCRIPTIONS_PER_STATUS || rows.some(row => SUBSCRIBED.has(status) || (row.paidThrough ?? 0) > now)) return true;
  }
  return false;
}

/** The held lock: resume the owner's own open, unexpired session for the same sku, else pending. */
async function heldLock(ctx: MutationCtx, purchaseRef: Id<"billingPurchases">, sku: Sku, now: number) {
  const purchase = await ctx.db.get("billingPurchases", purchaseRef);
  if (purchase?.state === "open" && purchase.checkoutUrl !== undefined && purchase.terms.sku === sku &&
    (purchase.expiresAt === undefined || purchase.expiresAt > now)) {
    return { kind: "resume" as const, checkoutUrl: purchase.checkoutUrl };
  }
  // A route that crashed after reserving may have created a session: recovery decides, never time.
  if (purchase?.state === "preparing" && now - purchase._creationTime > CHECKOUT_PREPARE_STALE_MS) {
    await ctx.db.patch("billingPurchases", purchaseRef, { state: "unknown" });
    console.warn("[billingCheckout] stale preparing purchase marked unknown", { purchaseRef });
  }
  return { kind: "pending" as const };
}

const refused = (code: "already_subscribed" | "not_pro" | "top_up_cap" | "support_required" | "unavailable" | "on_hold") =>
  ({ kind: "refused" as const, code });

/** Decides the next step of a checkout request. Never calls the provider. */
export const prepareCheckout = mutation({
  args: { internalKey: v.string(), mode: billingModeValidator, sku: skuValidator, productId: v.string() },
  returns: v.union(
    v.object({ kind: v.literal("resume"), checkoutUrl: v.string() }),
    v.object({ kind: v.literal("pending") }),
    v.object({
      kind: v.literal("refused"),
      code: v.union(
        v.literal("already_subscribed"), v.literal("not_pro"), v.literal("top_up_cap"), v.literal("support_required"), v.literal("unavailable"),
        v.literal("on_hold"),
      ),
    }),
    v.object({ kind: v.literal("create_customer"), customerRef: v.id("billingCustomers"), leaseId: v.string() }),
    // `customerId`: the provider customer bound to the caller's own row in `mode`, for the checkout create.
    v.object({ kind: v.literal("create_checkout"), purchaseRef: v.id("billingPurchases"), intentId: v.string(), customerId: v.string() }),
  ),
  handler: async (ctx, { internalKey, mode, sku, productId }) => {
    const identity = await authorize(ctx, internalKey);
    if (!catalogMatches(mode, sku, productId)) {
      console.error("[billingCheckout] catalog mismatch; checkout unavailable", { sku });
      return refused("unavailable");
    }
    // Throws FORBIDDEN for a held or deleted owner, before any lock is resumed.
    const customerRef = await ensureCustomerRow(ctx, { mode, ownerTokenIdentifier: identity.tokenIdentifier, userId: identity.subject });
    const customer = (await ctx.db.get("billingCustomers", customerRef))!;
    const now = Date.now();
    // A dispute or support hold: never hand out a new checkout or resume an open one.
    if (await hasActiveHold(ctx, customerRef)) return refused("on_hold");
    if (customer.pendingPurchaseRef) return await heldLock(ctx, customer.pendingPurchaseRef, sku, now);
    // Refusals come before customer creation, so no email leaves us for a request we would refuse.
    if (sku === "pro_monthly") {
      if (await hasSubscription(ctx, customerRef, now)) return refused("already_subscribed");
    } else {
      if (!isInPaidPeriod(await readPeriodLots(ctx, customer.userId, mode, now), now)) return refused("not_pro");
      if (await countActiveLots(ctx, customer.userId, mode, "top_up", now) >= MAX_ACTIVE_LOTS.top_up) return refused("top_up_cap");
    }
    if (customer.creationState === "unknown") return refused("support_required");
    if (customer.creationState === "preparing") {
      if (customer.creationLeaseId === undefined) {
        const leaseId = crypto.randomUUID();
        await ctx.db.patch("billingCustomers", customerRef, { creationLeaseId: leaseId, creationLeasedAt: now });
        return { kind: "create_customer" as const, customerRef, leaseId };
      }
      if (now - (customer.creationLeasedAt ?? 0) <= CUSTOMER_LEASE_STALE_MS) return { kind: "pending" as const };
      // A crashed create may have made a provider customer; support resolves it, never a second create.
      await ctx.db.patch("billingCustomers", customerRef, { creationState: "unknown" });
      console.warn("[billingCheckout] stale customer lease marked unknown", { customerRef });
      return refused("support_required");
    }
    const intentId = crypto.randomUUID();
    const purchaseRef = await reservePurchaseRow(ctx, {
      customerRef, intentId,
      terms: {
        sku, catalogVersion: BILLING_CATALOG_VERSION, productId, quantity: 1,
        credits: sku === "pro_monthly" ? PLANS.pro.monthlyCredits : TOP_UP.credits,
      },
    });
    // reservePurchaseRow only reserves for a `ready` customer with a bound provider ID.
    return { kind: "create_checkout" as const, purchaseRef, intentId, customerId: customer.customerId! };
  },
});

/** Records Next's provider customer create under the caller's lease. Never adopts another owner's customer. */
export const recordCustomerResult = mutation({
  args: {
    internalKey: v.string(), customerRef: v.id("billingCustomers"), leaseId: v.string(),
    result: v.union(v.object({ kind: v.literal("created"), customerId: v.string() }), notCreated, unknownOutcome),
  },
  returns: v.null(),
  handler: async (ctx, { internalKey, customerRef, leaseId, result }) => {
    const identity = await authorize(ctx, internalKey);
    const customer = await ownedCustomer(ctx, identity, customerRef);
    if (customer.creationLeaseId !== leaseId || customer.creationState === "ready") throw conflict();
    const unknown = () => ctx.db.patch("billingCustomers", customerRef, { creationState: "unknown" });
    if (result.kind === "created" && PROVIDER_ID.test(result.customerId)) {
      const bound = await ctx.db.query("billingCustomers")
        .withIndex("by_mode_and_customerId", q => q.eq("mode", customer.mode).eq("customerId", result.customerId)).unique();
      if (bound && bound._id !== customerRef) {
        // The provider may return an existing customer for a known email: support decides, never a bind.
        await unknown();
        console.error("[billingCheckout] created customer is bound to another owner", { customerRef, boundRef: bound._id });
        return null;
      }
      await bindCustomerRow(ctx, { customerRef, customerId: result.customerId });
      await ctx.db.patch("billingCustomers", customerRef, { creationLeaseId: undefined, creationLeasedAt: undefined });
    } else if (customer.creationState === "unknown") {
      // Only a late `created` changes an unknown customer; support owns the rest.
      console.warn("[billingCheckout] ignored result for unknown customer", { customerRef, kind: result.kind });
    } else if (result.kind === "not_created") {
      await ctx.db.patch("billingCustomers", customerRef, { creationLeaseId: undefined, creationLeasedAt: undefined });
    } else {
      // Lost response, or a malformed ID: the lease stays for support.
      await unknown();
      console.warn("[billingCheckout] customer creation outcome unknown", { customerRef });
    }
    return null;
  },
});

/** Records Next's checkout create for the caller's locked purchase. Binds only the session, never a payment. */
export const recordCheckoutResult = mutation({
  args: {
    internalKey: v.string(), purchaseRef: v.id("billingPurchases"),
    result: v.union(
      v.object({ kind: v.literal("created"), sessionId: v.string(), checkoutUrl: v.optional(v.string()), expiresAt: v.optional(v.number()) }),
      notCreated, unknownOutcome,
    ),
  },
  returns: v.null(),
  handler: async (ctx, { internalKey, purchaseRef, result }) => {
    const identity = await authorize(ctx, internalKey);
    const purchase = await ctx.db.get("billingPurchases", purchaseRef);
    if (!purchase) throw notFound();
    const customer = await ownedCustomer(ctx, identity, purchase.customerRef);
    if (customer.pendingPurchaseRef !== purchaseRef || (purchase.state !== "preparing" && purchase.state !== "unknown")) throw conflict();
    if (result.kind === "created" && PROVIDER_ID.test(result.sessionId)) {
      await bindPurchaseRow(ctx, { purchaseRef, mode: purchase.mode, sessionId: result.sessionId, expiresAt: result.expiresAt });
      const url = result.checkoutUrl;
      const trusted = url !== undefined && isDodoCheckoutUrl(purchase.mode, url);
      if (url !== undefined && !trusted) {
        console.error("[billingCheckout] checkout URL not on the allowed host; dropped", { purchaseRef });
      }
      await ctx.db.patch("billingPurchases", purchaseRef, { state: "open", ...(trusted ? { checkoutUrl: url } : {}) });
      await markPollDue(ctx, customer._id, false);
    } else if (purchase.state === "unknown") {
      // A session may exist: only a late `created` changes an unknown purchase, and the lock stays.
      console.warn("[billingCheckout] ignored result for unknown purchase", { purchaseRef, kind: result.kind });
    } else if (result.kind === "not_created") {
      await ctx.db.patch("billingPurchases", purchaseRef, { state: "terminal" });
      await ctx.db.patch("billingCustomers", customer._id, { pendingPurchaseRef: undefined });
    } else {
      await ctx.db.patch("billingPurchases", purchaseRef, { state: "unknown" });
      console.warn("[billingCheckout] checkout creation outcome unknown; lock kept", { purchaseRef });
      await markPollDue(ctx, customer._id, false);
    }
    return null;
  },
});
