import { v, type Infer } from "convex/values";

import { DodoReadError, fetchCheckoutSession, listCustomerResources } from "../src/features/billing/server/dodo-reads";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, type MutationCtx } from "./_generated/server";
import { recordReceiptRow } from "./billing";
import { readConvexBillingConfig } from "./billingEnv";
import { sha256Hex } from "./billingWebhook";
import { billingModeValidator } from "./schema";

/**
 * Bounded provider polling (stage 9, docs/billing-stage9.md). It only records synthetic receipts
 * through the normal queue, so every money effect still goes through the fenced commit; the one
 * exception is releasing an expired, unpaid checkout lock on fresh provider evidence.
 */

const DAY_MS = 24 * 60 * 60_000;
export const POLL_BATCH = 20; // customers per cron run
export const POLL_READS_PER_CUSTOMER = 6; // ≤ 20 per action, like a claim
export const ACTIVE_POLL_MS = 15 * 60_000; // a held checkout lock, or a subscription near its paidThrough
export const IDLE_POLL_MS = 6 * 60 * 60_000; // an active subscription, or a settled customer still watched
export const NEAR_EXPIRY_MS = 2 * DAY_MS;
export const POLL_LOOKBACK_MS = 3 * DAY_MS;
export const REVERSAL_WATCH_MS = 120 * DAY_MS; // refund/dispute window after a settlement
/**
 * The provider exposes no checkout expiry (SDK 2.63.0 `CheckoutSessionStatus`). Sessions expire 24 h
 * after creation by default (15 min only with `confirm: true`, which our checkout never sends):
 * https://docs.dodopayments.com/developer-resources/checkout-session
 */
export const CHECKOUT_SESSION_TTL_MS = DAY_MS;
// Provider timestamps are compared with ours: anything this close to the purchase counts as after it.
export const PROVIDER_CLOCK_SKEW_MS = 5 * 60_000;

// What each list contributes: payments and refunds only once they succeeded; every dispute and subscription status.
const SOURCES = [
  { list: "payments", kind: "payment", keep: (status: string) => status === "succeeded" },
  { list: "refunds", kind: "refund", keep: (status: string) => status === "succeeded" },
  { list: "disputes", kind: "dispute", keep: () => true },
  { list: "subscriptions", kind: "subscription", keep: () => true },
] as const;
// A session payment in any other status may still complete, or did.
const DEAD_PAYMENT = new Set(["failed", "cancelled"]);
const LIVE_SUBSCRIPTION = new Set(["pending", "active", "on_hold", "paused"]);
const ENDED_SUBSCRIPTION = new Set(["cancelled", "expired", "failed"]);
const LOCAL_ENDED = new Set<Doc<"billingSubscriptions">["status"]>(["cancelled", "expired", "quarantined"]);

const findingValidator = v.object({
  kind: v.union(v.literal("payment"), v.literal("refund"), v.literal("dispute"), v.literal("subscription")),
  id: v.string(), status: v.string(), createdAt: v.number(), paymentId: v.optional(v.string()),
  webhookId: v.string(), bodyDigest: v.string(),
});
const checkoutValidator = v.object({ purchaseRef: v.id("billingPurchases"), sessionId: v.string() });
const sessionValidator = v.object({ createdAt: v.number(), paymentId: v.optional(v.string()), paymentStatus: v.optional(v.string()) });
type Finding = Infer<typeof findingValidator>;

/** Makes a customer due within ACTIVE_POLL_MS; a settlement also extends the reversal watch. */
export async function markPollDue(ctx: MutationCtx, customerRef: Id<"billingCustomers">, watch: boolean) {
  const customer = await ctx.db.get("billingCustomers", customerRef);
  if (!customer) return;
  const now = Date.now();
  await ctx.db.patch("billingCustomers", customerRef, {
    nextPollAt: Math.min(customer.nextPollAt ?? Infinity, now + ACTIVE_POLL_MS),
    ...(watch ? { watchUntil: Math.max(customer.watchUntil ?? 0, now + REVERSAL_WATCH_MS) } : {}),
  });
}

/** Undefined: nothing left to poll for. */
async function pollDelay(ctx: MutationCtx, customer: Doc<"billingCustomers">, now: number) {
  if (customer.pendingPurchaseRef) return ACTIVE_POLL_MS;
  const subscription = customer.activeSubscriptionRef && await ctx.db.get("billingSubscriptions", customer.activeSubscriptionRef);
  if (subscription?.status === "active") return (subscription.paidThrough ?? 0) - now < NEAR_EXPIRY_MS ? ACTIVE_POLL_MS : IDLE_POLL_MS;
  return (customer.watchUntil ?? 0) > now ? IDLE_POLL_MS : undefined;
}

// Cron: due customers of this deployment's mode, bounded; one action each.
export const selectPollTargets = internalMutation({
  args: {},
  returns: v.null(),
  handler: async ctx => {
    const config = readConvexBillingConfig("convex-reconciler");
    if (!config) return null;
    const now = Date.now();
    const due = await ctx.db.query("billingCustomers")
      .withIndex("by_mode_and_nextPollAt", q => q.eq("mode", config.environment).gte("nextPollAt", 0).lte("nextPollAt", now))
      .take(POLL_BATCH + 1);
    if (due.length > POLL_BATCH) console.error("[billingPoll] poll backlog", { mode: config.environment });
    for (const customer of due.slice(0, POLL_BATCH)) {
      // Pushed first, so an overlapping run never selects it twice; the poll's record sets the real cadence.
      await ctx.db.patch("billingCustomers", customer._id, { nextPollAt: customer.customerId ? now + ACTIVE_POLL_MS : undefined });
      if (!customer.customerId) continue;
      const purchase = customer.pendingPurchaseRef && await ctx.db.get("billingPurchases", customer.pendingPurchaseRef);
      const checkout = purchase && (purchase.state === "open" || purchase.state === "terminal") && purchase.sessionId
        ? { purchaseRef: purchase._id, sessionId: purchase.sessionId } : undefined;
      // The lists reach back past a held purchase, so its release can see every payment and subscription since.
      const from = Math.min(customer.lastPolledAt ?? customer._creationTime, purchase ? purchase._creationTime : Infinity);
      await ctx.scheduler.runAfter(0, internal.billingPoll.pollCustomer, {
        customerRef: customer._id, mode: customer.mode, customerId: customer.customerId, since: from - POLL_LOOKBACK_MS,
        ...(checkout ? { checkout } : {}),
      });
    }
    return null;
  },
});

export const pollCustomer = internalAction({
  args: {
    customerRef: v.id("billingCustomers"), mode: billingModeValidator, customerId: v.string(), since: v.number(),
    checkout: v.optional(checkoutValidator),
  },
  returns: v.null(),
  handler: async (ctx, { customerRef, mode, customerId, since, checkout }) => {
    const config = readConvexBillingConfig("convex-reconciler");
    if (!config || config.environment !== mode) return null;
    const polledAt = Date.now();
    let reads = 0;
    let complete = true;
    async function read<T>(label: string, run: () => Promise<T>): Promise<T | null> {
      if (reads >= POLL_READS_PER_CUSTOMER) return (complete = false, null);
      reads += 1;
      try {
        return await run();
      } catch (error) {
        if (!(error instanceof DodoReadError)) throw error;
        complete = false;
        console.error("[billingPoll] provider read failed", { customerRef, read: label, status: error.status, retryable: error.retryable });
        return null;
      }
    }
    const findings: Finding[] = [];
    for (const { list, kind, keep } of SOURCES) {
      const page = await read(list, () => listCustomerResources(config, list, customerId, since));
      if (!page) continue;
      if (page.full) {
        // The page may hide older items: not complete, so lastPolledAt stays and nothing is released.
        complete = false;
        console.warn("[billingPoll] page full", { customerRef, list });
      }
      for (const item of page.items.filter(item => keep(item.status))) {
        // One receipt per resource per observed status: a repeat is a no-op, a new status records again.
        const webhookId = `poll:${kind}:${item.id}:${item.status}`;
        const bodyDigest = await sha256Hex(new TextEncoder().encode(webhookId));
        findings.push({ kind, ...item, ...(kind === "payment" ? { paymentId: item.id } : {}), webhookId, bodyDigest });
      }
    }
    const session = checkout ? await read("checkout", () => fetchCheckoutSession(config, checkout.sessionId)) : null;
    await ctx.runMutation(internal.billingPoll.recordPollFindings, {
      customerRef, mode, polledAt, complete, findings, ...(checkout && session ? { checkout, session } : {}),
    });
    return null;
  },
});

/** Whether a receipt for this payment is still unresolved; a new one would only pile up behind it. */
async function hasUnresolvedReceipt(ctx: MutationCtx, mode: Doc<"billingCustomers">["mode"], paymentId: string) {
  for (const state of ["pending", "quarantined"] as const) {
    const row = await ctx.db.query("billingEvents")
      .withIndex("by_mode_and_paymentId_and_state", q => q.eq("mode", mode).eq("paymentId", paymentId).eq("state", state)).first();
    if (row) return true;
  }
  return false;
}

/** Records only findings that would change something. Returns whether a succeeded payment is still unbound. */
async function recordFindings(ctx: MutationCtx, customer: Doc<"billingCustomers">, findings: Finding[], now: number) {
  let unbound = false;
  for (const finding of findings) {
    if (finding.kind === "subscription") {
      const row = await ctx.db.query("billingSubscriptions")
        .withIndex("by_mode_and_subscriptionId", q => q.eq("mode", customer.mode).eq("subscriptionId", finding.id)).unique();
      if (row && !(ENDED_SUBSCRIPTION.has(finding.status) && !LOCAL_ENDED.has(row.status))) continue;
    } else {
      // Settlement and quarantine both bind the payment, so a seen payment stops being recorded.
      if (finding.kind === "payment") {
        const bound = await ctx.db.query("billingPurchases")
          .withIndex("by_mode_and_paymentId", q => q.eq("mode", customer.mode).eq("paymentId", finding.id)).unique();
        if (bound) continue;
        unbound = true;
      }
      if (await hasUnresolvedReceipt(ctx, customer.mode, finding.paymentId!)) continue;
    }
    await recordReceiptRow(ctx, {
      customerRef: customer._id, mode: customer.mode, webhookId: finding.webhookId, eventType: `${finding.kind}.poll`,
      bodyDigest: finding.bodyDigest, occurredAt: now,
      ...(finding.kind === "subscription" ? { subscriptionId: finding.id } : { paymentId: finding.paymentId }),
    });
  }
  return unbound;
}

/**
 * Releases the lock on evidence only: the held purchase is unchanged (open or terminal, same session, no
 * payment), its session is past the documented lifetime, the session shows no live payment and, for Pro,
 * no live subscription was created since the purchase. A late payment still settles it by its session.
 */
async function releaseExpiredCheckout(
  ctx: MutationCtx, customer: Doc<"billingCustomers">, checkout: Infer<typeof checkoutValidator>,
  session: Infer<typeof sessionValidator>, findings: Finding[], now: number,
) {
  if (customer.pendingPurchaseRef !== checkout.purchaseRef) return;
  const purchase = await ctx.db.get("billingPurchases", checkout.purchaseRef);
  if (!purchase || !["open", "terminal"].includes(purchase.state) || purchase.sessionId !== checkout.sessionId || purchase.paymentId) return;
  if (now <= Math.max(purchase.expiresAt ?? 0, session.createdAt + CHECKOUT_SESSION_TTL_MS)) return;
  if ((session.paymentId !== undefined || session.paymentStatus !== undefined) && !DEAD_PAYMENT.has(session.paymentStatus ?? "")) return;
  if (purchase.terms.sku === "pro_monthly" && findings.some(f =>
    f.kind === "subscription" && LIVE_SUBSCRIPTION.has(f.status) && f.createdAt >= purchase._creationTime - PROVIDER_CLOCK_SKEW_MS)) return;
  await ctx.db.patch("billingPurchases", purchase._id, { state: "terminal" });
  await ctx.db.patch("billingCustomers", customer._id, { pendingPurchaseRef: undefined });
  console.info("[billingPoll] expired checkout released", { customerRef: customer._id, purchaseRef: purchase._id });
}

export const recordPollFindings = internalMutation({
  args: {
    customerRef: v.id("billingCustomers"), mode: billingModeValidator, polledAt: v.number(), complete: v.boolean(),
    findings: v.array(findingValidator), checkout: v.optional(checkoutValidator), session: v.optional(sessionValidator),
  },
  returns: v.null(),
  handler: async (ctx, { customerRef, mode, polledAt, complete, findings, checkout, session }) => {
    const customer = await ctx.db.get("billingCustomers", customerRef);
    if (!customer || customer.mode !== mode) return null;
    const now = Date.now();
    const unbound = await recordFindings(ctx, customer, findings, now);
    // A read failure, a full page or an unbound succeeded payment keeps the lock.
    if (complete && !unbound && checkout && session) await releaseExpiredCheckout(ctx, customer, checkout, session, findings, now);
    const current = (await ctx.db.get("billingCustomers", customerRef))!;
    const delay = await pollDelay(ctx, current, now);
    await ctx.db.patch("billingCustomers", customerRef, {
      nextPollAt: delay === undefined ? undefined : now + delay, ...(complete ? { lastPolledAt: polledAt } : {}),
    });
    return null;
  },
});
