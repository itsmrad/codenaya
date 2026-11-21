import { v, type Infer } from "convex/values";

import {
  DodoReadError, fetchCheckoutSession, fetchPayment, fetchSubscription, listCustomerResources, type ListKind,
} from "../src/features/billing/server/dodo-reads";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, type MutationCtx } from "./_generated/server";
import { recordReceiptRow } from "./billing";
import { readConvexBillingConfig } from "./billingEnv";
import { sha256Hex } from "./billingWebhook";
import { billingModeValidator, billingPollWindowValidator } from "./schema";

/**
 * Bounded provider polling (stage 9, docs/billing-stage9.md). It only records synthetic receipts
 * through the normal queue, so every money effect still goes through the fenced commit; the one
 * exception is releasing an expired, unpaid checkout lock on fresh provider evidence.
 */

const DAY_MS = 24 * 60 * 60_000;
export const POLL_BATCH = 20; // customers per cron run
export const MAX_KNOWN_SUBSCRIPTIONS = 3; // our pending/active rows re-read by id, whatever their age
export const MAX_REVERSAL_REREADS = 2; // payments with an unresolved refund/dispute receipt, re-read for status changes
// 4 list pages + 1 session + the re-reads: ≤ 20 per action, like a claim; ≤ 200 reads per cron run.
export const POLL_READS_PER_CUSTOMER = 5 + MAX_KNOWN_SUBSCRIPTIONS + MAX_REVERSAL_REREADS;
export const ACTIVE_POLL_MS = 15 * 60_000; // a held checkout lock, a window still paging, or a subscription near its paidThrough
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
// Provider timestamps are compared with ours, always in the direction that keeps the lock.
export const PROVIDER_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_UNRESOLVED_CHECK = 20;
// Pages per list per window (20 items each). Past it the window closes without release evidence.
export const MAX_POLL_PAGES = 50;

const LISTS = ["payments", "refunds", "disputes", "subscriptions"] as const satisfies readonly ListKind[];
const KIND = { payments: "payment", refunds: "refund", disputes: "dispute", subscriptions: "subscription" } as const;
// A session or listed payment in any other status may still complete, or did.
const DEAD_PAYMENT = new Set(["failed", "cancelled"]);
// Any other subscription status, unrecognised ones included, counts as live.
const ENDED_SUBSCRIPTION = new Set(["cancelled", "expired", "failed"]);
const LOCAL_ENDED = new Set<Doc<"billingSubscriptions">["status"]>(["cancelled", "expired", "quarantined"]);
const NEGATIVE_EVENT = /^(refund|dispute)\./;

const findingValidator = v.object({
  kind: v.union(v.literal("payment"), v.literal("refund"), v.literal("dispute"), v.literal("subscription")),
  // createdAt is absent for a resource re-read by id.
  id: v.string(), status: v.string(), createdAt: v.optional(v.number()), paymentId: v.optional(v.string()),
  webhookId: v.string(), bodyDigest: v.string(), readId: v.optional(v.string()),
});
const checkoutValidator = v.object({ purchaseRef: v.id("billingPurchases"), sessionId: v.string() });
const sessionValidator = v.object({ createdAt: v.number(), paymentId: v.optional(v.string()), paymentStatus: v.optional(v.string()) });
type Finding = Infer<typeof findingValidator>;
type PollWindow = Infer<typeof billingPollWindowValidator>;
type Pages = PollWindow["pages"];

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
  const pending = await ctx.db.query("billingSubscriptions").withIndex("by_customerRef_and_controlPendingAt", q =>
    q.eq("customerRef", customer._id).gte("controlPendingAt", 0)).first();
  if (customer.cancellationRecoveryRequired && customer.cancellationLastOutcome !== "support" || pending || customer.pendingPurchaseRef || customer.pollWindow) return ACTIVE_POLL_MS;
  const subscription = customer.activeSubscriptionRef && await ctx.db.get("billingSubscriptions", customer.activeSubscriptionRef);
  if (subscription?.status === "active") return (subscription.paidThrough ?? 0) - now < NEAR_EXPIRY_MS ? ACTIVE_POLL_MS : IDLE_POLL_MS;
  return (customer.watchUntil ?? 0) > now ? IDLE_POLL_MS : undefined;
}

/** Our not-ended subscriptions and the payments of unresolved refund/dispute receipts, re-read by id each poll. */
async function rereadIds(ctx: MutationCtx, customerRef: Id<"billingCustomers">) {
  const pending = await ctx.db.query("billingSubscriptions").withIndex("by_customerRef_and_controlPendingAt", q =>
    q.eq("customerRef", customerRef).gte("controlPendingAt", 0)).take(MAX_KNOWN_SUBSCRIPTIONS);
  const subscriptionIds = new Set(pending.map(row => row.subscriptionId));
  for (const status of ["active", "pending"] as const) {
    const rows = await ctx.db.query("billingSubscriptions")
      .withIndex("by_customerRef_and_status", q => q.eq("customerRef", customerRef).eq("status", status)).take(MAX_KNOWN_SUBSCRIPTIONS);
    for (const row of rows) subscriptionIds.add(row.subscriptionId);
  }
  const paymentIds = new Set<string>();
  for (const state of ["pending", "quarantined"] as const) {
    for (const prefix of ["refund", "dispute"]) {
      const rows = await ctx.db.query("billingEvents").withIndex("by_customerRef_and_state_and_eventType", q =>
        q.eq("customerRef", customerRef).eq("state", state).gte("eventType", `${prefix}.`).lt("eventType", `${prefix}/`)).take(MAX_REVERSAL_REREADS);
      for (const row of rows) if (row.paymentId) paymentIds.add(row.paymentId);
    }
  }
  return { subscriptionIds: [...subscriptionIds].slice(0, MAX_KNOWN_SUBSCRIPTIONS), paymentIds: [...paymentIds].slice(0, MAX_REVERSAL_REREADS) };
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
      await ctx.db.patch("billingCustomers", customer._id, { nextPollAt: customer.customerId ? now + ((customer.cancellationRecoveryRequired && customer.cancellationLastOutcome === "support") ? IDLE_POLL_MS : ACTIVE_POLL_MS) : undefined });
      if (!customer.customerId) continue;
      const purchase = customer.pendingPurchaseRef && await ctx.db.get("billingPurchases", customer.pendingPurchaseRef);
      const checkout = purchase && (purchase.state === "open" || purchase.state === "terminal") && purchase.sessionId
        ? { purchaseRef: purchase._id, sessionId: purchase.sessionId } : undefined;
      // A new window reaches back past a held purchase, so its release sees every payment and subscription since.
      const from = Math.min(customer.lastPolledAt ?? customer._creationTime, purchase ? purchase._creationTime : Infinity);
      const window = customer.pollWindow ?? {
        since: from - POLL_LOOKBACK_MS, until: now, pages: { payments: 0, refunds: 0, disputes: 0, subscriptions: 0 }, blocked: false,
      };
      await ctx.scheduler.runAfter(0, internal.billingPoll.pollCustomer, {
        customerRef: customer._id, mode: customer.mode, customerId: customer.customerId, window,
        ...(await rereadIds(ctx, customer._id)), ...(checkout ? { checkout } : {}),
      });
    }
    return null;
  },
});

export const pollCustomer = internalAction({
  args: {
    customerRef: v.id("billingCustomers"), mode: billingModeValidator, customerId: v.string(), window: billingPollWindowValidator,
    subscriptionIds: v.array(v.string()), paymentIds: v.array(v.string()), checkout: v.optional(checkoutValidator),
  },
  returns: v.null(),
  handler: async (ctx, { customerRef, mode, customerId, window, subscriptionIds, paymentIds, checkout }) => {
    const config = readConvexBillingConfig("convex-reconciler");
    if (!config || config.environment !== mode) return null;
    let reads = 0;
    let failed = false;
    async function read<T>(label: string, run: () => Promise<T>): Promise<T | null> {
      if (reads >= POLL_READS_PER_CUSTOMER) return (failed = true, null);
      reads += 1;
      try {
        return await run();
      } catch (error) {
        if (!(error instanceof DodoReadError)) throw error;
        failed = true;
        console.error("[billingPoll] provider read failed", { customerRef, read: label, status: error.status, retryable: error.retryable });
        return null;
      }
    }
    const findings: Finding[] = [];
    // One finding per resource per observed status: a repeat is a no-op receipt, a new status records again.
    async function found(kind: Finding["kind"], item: Omit<Finding, "kind" | "webhookId" | "bodyDigest">) {
      const webhookId = `poll:${kind}:${item.id}:${item.status}`;
      findings.push({ kind, ...item, ...(kind === "subscription" ? { readId: crypto.randomUUID() } : {}), webhookId, bodyDigest: await sha256Hex(new TextEncoder().encode(webhookId)) });
    }
    // Pages still to read; a failed page is read again next run, a full one moves on to the next.
    const pages: Pages = {};
    let capped = false;
    for (const list of LISTS) {
      const page = window.pages[list];
      if (page === undefined) continue;
      const result = await read(list, () => listCustomerResources(config, list, customerId, { since: window.since, until: window.until, page }));
      if (!result) pages[list] = page;
      else if (result.full && page + 1 >= MAX_POLL_PAGES) capped = true;
      else if (result.full) pages[list] = page + 1;
      for (const item of result?.items ?? []) await found(KIND[list], { ...item, ...(list === "payments" ? { paymentId: item.id } : {}) });
    }
    const session = checkout ? await read("checkout", () => fetchCheckoutSession(config, checkout.sessionId)) : null;
    for (const id of subscriptionIds.filter(id => !findings.some(f => f.kind === "subscription" && f.id === id))) {
      const subscription = await read("subscription", () => fetchSubscription(config, id));
      if (subscription && subscription.customerId === customerId) await found("subscription", { id, status: subscription.status });
    }
    for (const paymentId of paymentIds) {
      const payment = await read("payment", () => fetchPayment(config, paymentId));
      if (!payment || payment.customerId !== customerId) continue;
      for (const refund of payment.adjustments?.refunds ?? []) await found("refund", { id: refund.refundId, status: refund.status, paymentId });
      for (const dispute of payment.adjustments?.disputes ?? []) await found("dispute", { id: dispute.disputeId, status: dispute.status, paymentId });
    }
    await ctx.runMutation(internal.billingPoll.recordPollFindings, {
      customerRef, mode, window, pages, failed, capped, findings, ...(checkout && session ? { checkout, session } : {}),
    });
    return null;
  },
});

/** Whether an unresolved positive receipt for this payment exists; another one would only pile up behind it. */
async function hasUnresolvedPositive(ctx: MutationCtx, mode: Doc<"billingCustomers">["mode"], paymentId: string) {
  for (const state of ["pending", "quarantined"] as const) {
    const rows = await ctx.db.query("billingEvents")
      .withIndex("by_mode_and_paymentId_and_state", q => q.eq("mode", mode).eq("paymentId", paymentId).eq("state", state))
      .take(MAX_UNRESOLVED_CHECK + 1);
    // Past the bound one may be unread: skip, as recording is only ever deferred.
    if (rows.length > MAX_UNRESOLVED_CHECK || rows.some(row => !NEGATIVE_EVENT.test(row.eventType))) return true;
  }
  return false;
}

/** Records only findings that would change something. */
async function recordFindings(ctx: MutationCtx, customer: Doc<"billingCustomers">, findings: Finding[], now: number) {
  for (const finding of findings) {
    let { webhookId, bodyDigest } = finding;
    if (finding.kind === "subscription") {
      const row = await ctx.db.query("billingSubscriptions")
        .withIndex("by_mode_and_subscriptionId", q => q.eq("mode", customer.mode).eq("subscriptionId", finding.id)).unique();
      if (row?.customerRef === customer._id && row.controlPendingAt !== undefined) {
        // Same provider status can resolve distinct control claims and later crash-recovery reads.
        webhookId = `poll:control:${finding.id}:${row.controlRevision}:${finding.readId ?? now}`;
        bodyDigest = await sha256Hex(new TextEncoder().encode(webhookId));
      } else if (row && !(ENDED_SUBSCRIPTION.has(finding.status) && !LOCAL_ENDED.has(row.status))) continue;
    } else if (finding.kind === "payment") {
      // Only once succeeded. Settlement and quarantine both bind it, so a seen payment stops being recorded.
      if (finding.status !== "succeeded") continue;
      const bound = await ctx.db.query("billingPurchases")
        .withIndex("by_mode_and_paymentId", q => q.eq("mode", customer.mode).eq("paymentId", finding.id)).unique();
      if (bound || await hasUnresolvedPositive(ctx, customer.mode, finding.id)) continue;
    } else if (finding.kind === "refund" && finding.status !== "succeeded") {
      continue;
    }
    // Refunds and disputes are never suppressed by another receipt of their payment: the status-keyed id dedupes.
    await recordReceiptRow(ctx, {
      customerRef: customer._id, mode: customer.mode, webhookId, eventType: `${finding.kind}.poll`,
      bodyDigest, occurredAt: now,
      ...(finding.kind === "subscription" ? { subscriptionId: finding.id } : { paymentId: finding.paymentId }),
    });
  }
}

/**
 * A listed payment, or for Pro a subscription, that is live and may belong to the held checkout keeps
 * its lock. A succeeded payment already bound to another purchase of another session (a renewal, an
 * earlier top-up) is that purchase's, never this checkout's.
 */
async function blocksRelease(ctx: MutationCtx, finding: Finding, purchase: Doc<"billingPurchases">) {
  const mayBelong = finding.createdAt === undefined || finding.createdAt >= purchase._creationTime - PROVIDER_CLOCK_SKEW_MS;
  if (finding.kind === "subscription") return purchase.terms.sku === "pro_monthly" && mayBelong && !ENDED_SUBSCRIPTION.has(finding.status);
  if (finding.kind !== "payment" || !mayBelong || DEAD_PAYMENT.has(finding.status)) return false;
  if (finding.status !== "succeeded") return true;
  const bound = await ctx.db.query("billingPurchases")
    .withIndex("by_mode_and_paymentId", q => q.eq("mode", purchase.mode).eq("paymentId", finding.id)).unique();
  return !bound || bound._id === purchase._id || bound.sessionId === purchase.sessionId;
}

/**
 * Releases the lock on evidence only, after a fully read window with no blocker: the held purchase is
 * unchanged (open or terminal, same session, no payment), the window ends past the session's documented
 * lifetime (so every payment of the session was listed), and the session shows no live payment. A late
 * payment still settles the released purchase by its session.
 */
async function releaseExpiredCheckout(
  ctx: MutationCtx, customer: Doc<"billingCustomers">, checkout: Infer<typeof checkoutValidator>,
  session: Infer<typeof sessionValidator>, until: number,
) {
  if (customer.pendingPurchaseRef !== checkout.purchaseRef) return;
  const purchase = await ctx.db.get("billingPurchases", checkout.purchaseRef);
  if (!purchase || !["open", "terminal"].includes(purchase.state) || purchase.sessionId !== checkout.sessionId || purchase.paymentId) return;
  if (until <= Math.max(purchase.expiresAt ?? 0, session.createdAt + CHECKOUT_SESSION_TTL_MS) + PROVIDER_CLOCK_SKEW_MS) return;
  if ((session.paymentId !== undefined || session.paymentStatus !== undefined) && !DEAD_PAYMENT.has(session.paymentStatus ?? "")) return;
  await ctx.db.patch("billingPurchases", purchase._id, { state: "terminal" });
  await ctx.db.patch("billingCustomers", customer._id, { pendingPurchaseRef: undefined });
  console.info("[billingPoll] expired checkout released", { customerRef: customer._id, purchaseRef: purchase._id });
}

export const recordPollFindings = internalMutation({
  args: {
    customerRef: v.id("billingCustomers"), mode: billingModeValidator, window: billingPollWindowValidator,
    pages: billingPollWindowValidator.fields.pages, failed: v.boolean(), capped: v.boolean(), findings: v.array(findingValidator),
    checkout: v.optional(checkoutValidator), session: v.optional(sessionValidator),
  },
  returns: v.null(),
  handler: async (ctx, { customerRef, mode, window, pages, failed, capped, findings, checkout, session }) => {
    const customer = await ctx.db.get("billingCustomers", customerRef);
    if (!customer || customer.mode !== mode) return null;
    const now = Date.now();
    await recordFindings(ctx, customer, findings, now);
    // A stale action (its window already replaced) records findings but never advances or releases.
    const current = customer.pollWindow === undefined || customer.pollWindow.until === window.until;
    const held = customer.pendingPurchaseRef && await ctx.db.get("billingPurchases", customer.pendingPurchaseRef);
    let blocked = window.blocked || capped;
    for (const finding of findings) {
      if (blocked || !held) break;
      blocked = await blocksRelease(ctx, finding, held);
    }
    // An operator case: the window holds more than MAX_POLL_PAGES pages, so the lock is never released from it.
    if (capped) console.error("[billingPoll] page cap reached; lock kept", { customerRef, pages: MAX_POLL_PAGES });
    const remaining = LISTS.some(list => pages[list] !== undefined);
    if (current && !remaining && !failed && !blocked && checkout && session) {
      await releaseExpiredCheckout(ctx, customer, checkout, session, window.until);
    }
    if (remaining && LISTS.some(list => (pages[list] ?? 0) > (window.pages[list] ?? 0))) {
      console.warn("[billingPoll] page full; paging on", { customerRef, pages });
    }
    const windowPatch = !current ? {} : remaining
      ? { pollWindow: { ...window, pages, blocked } }
      : { pollWindow: undefined, lastPolledAt: window.until };
    await ctx.db.patch("billingCustomers", customerRef, windowPatch);
    const delay = await pollDelay(ctx, (await ctx.db.get("billingCustomers", customerRef))!, now);
    await ctx.db.patch("billingCustomers", customerRef, { nextPollAt: delay === undefined ? undefined : now + delay });
    return null;
  },
});
