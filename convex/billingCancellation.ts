import { v, type Infer } from "convex/values";

import { fetchCustomer, fetchCheckoutSession, fetchPayment, fetchSubscription, listCustomerResources } from "../src/features/billing/server/dodo-reads";
import { setDodoCancellation } from "../src/features/billing/server/dodo-subscription";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction, internalMutation, type QueryCtx } from "./_generated/server";
import { recordReceiptRow } from "./billing";
import { readConvexBillingConfig } from "./billingEnv";
import { MAX_LOTS_PER_PURCHASE } from "./billingReversals";
import { CHECKOUT_SESSION_TTL_MS, PROVIDER_CLOCK_SKEW_MS, MAX_POLL_PAGES } from "./billingPoll";
import { sha256Hex } from "./billingWebhook";
import { billingCancellationProgressValidator, billingModeValidator } from "./schema";

export const CANCELLATION_BATCH = 5;
export const CANCELLATION_FETCH_LIMIT = 20;
export const CANCELLATION_MAX_ATTEMPTS = 8;
export const CANCELLATION_BASE_DELAY_MS = 15 * 60_000;
export const CANCELLATION_MAX_DELAY_MS = 24 * 60 * 60_000;
export const CANCELLATION_LEASE_MS = 10 * 60_000;
const LOCAL_PROOF_LIMIT = 100; // Larger histories require support rather than an unbounded completion read.
const CHUNK = 3; // A subscription read + the adapter's five nested calls, three times, plus one list = 19.
const ENDED = new Set(["cancelled", "expired", "failed"]);
const DEAD_PAYMENT = new Set(["failed", "cancelled"]);
type Progress = Infer<typeof billingCancellationProgressValidator>;
const resourceValidator = v.object({
  subscriptionRef: v.optional(v.id("billingSubscriptions")), purchaseRef: v.optional(v.id("billingPurchases")),
  subscriptionId: v.optional(v.string()), sessionId: v.optional(v.string()), paymentId: v.optional(v.string()),
  state: v.optional(v.string()), expiresAt: v.optional(v.number()), grantProven: v.optional(v.boolean()),
});
const findingValidator = v.object({
  kind: v.union(v.literal("subscription"), v.literal("payment")), id: v.string(), status: v.string(), bodyDigest: v.string(),
});
const evidenceValidator = v.object({
  progress: billingCancellationProgressValidator, failed: v.boolean(), support: v.boolean(), retryAt: v.number(),
  ended: v.array(v.id("billingSubscriptions")), resolved: v.array(v.id("billingPurchases")), findings: v.array(findingValidator),
});

// Financial evidence survives expiry, spending and reversal; a rollover alone is not the original grant.
async function hasPurchaseGrant(ctx: QueryCtx, customer: Doc<"billingCustomers">, purchase: Doc<"billingPurchases">) {
  const lots = await ctx.db.query("billingGrants").withIndex("by_purchaseRef", q => q.eq("purchaseRef", purchase._id))
    .take(MAX_LOTS_PER_PURCHASE + 1);
  const originals = lots.filter(lot => lot.kind !== "rollover");
  if (lots.length > MAX_LOTS_PER_PURCHASE || originals.length !== 1 || !purchase.paymentId ||
    purchase.customerRef !== customer._id || purchase.mode !== customer.mode) return false;
  const lot = originals[0];
  if (lot.customerRef !== customer._id || lot.userId !== customer.userId || lot.mode !== customer.mode ||
    lot.quantity !== purchase.terms.credits) return false;
  return purchase.terms.sku === "top_up"
    ? lot.kind === "top_up" && lot.sourceKey === `top_up:${purchase.paymentId}:0`
    : lot.kind === "current_period" && !!purchase.subscriptionId && lot.serviceStart !== undefined &&
      lot.serviceEnd !== undefined && lot.serviceStart < lot.serviceEnd && lot.expiresAt === lot.serviceEnd &&
      lot.sourceKey === `period:${purchase.subscriptionId}:${lot.serviceStart}:${lot.serviceEnd}`;
}

export const selectCancellationTargets = internalMutation({
  args: {}, returns: v.null(),
  handler: async ctx => {
    const config = readConvexBillingConfig("convex-reconciler");
    if (!config) return null;
    const now = Date.now();
    const rows = await ctx.db.query("billingCustomers")
      .withIndex("by_mode_and_cancellationRecoveryRequired_and_cancellationNextAttemptAt", q =>
        q.eq("mode", config.environment).eq("cancellationRecoveryRequired", true).gte("cancellationNextAttemptAt", 0).lte("cancellationNextAttemptAt", now))
      .take(CANCELLATION_BATCH);
    for (const row of rows) {
      // Support remains indexed but requires new evidence/operator work; never turn exhaustion into success.
      await ctx.db.patch("billingCustomers", row._id, { cancellationNextAttemptAt: row.cancellationLastOutcome === "support" ? now + CANCELLATION_MAX_DELAY_MS :
        (row.cancellationLeaseExpiresAt ?? 0) > now ? row.cancellationLeaseExpiresAt : now + CANCELLATION_LEASE_MS });
      if (row.cancellationLastOutcome !== "support")
        await ctx.scheduler.runAfter(0, internal.billingCancellation.recoverCustomer, { customerRef: row._id });
    }
    return null;
  },
});

export const claimCancellation = internalMutation({
  args: { customerRef: v.id("billingCustomers") },
  returns: v.union(v.null(), v.object({
    generation: v.number(), inputRevision: v.number(), leaseId: v.string(), customerId: v.optional(v.string()), mode: billingModeValidator,
    progress: billingCancellationProgressValidator, resources: v.array(resourceValidator), nextCursor: v.union(v.string(), v.null()), localDone: v.boolean(),
    deletedAt: v.number(),
  })),
  handler: async (ctx, { customerRef }) => {
    const customer = await ctx.db.get("billingCustomers", customerRef);
    const now = Date.now();
    if (!customer || customer.deletedAt === undefined || !customer.cancellationRecoveryRequired ||
      customer.cancellationLastOutcome === "support") return null;
    if ((customer.cancellationLeaseExpiresAt ?? 0) > now) {
      await ctx.db.patch("billingCustomers", customerRef, { cancellationNextAttemptAt: customer.cancellationLeaseExpiresAt });
      return null;
    }
    if ((customer.cancellationAttempts ?? 0) >= CANCELLATION_MAX_ATTEMPTS) {
      await ctx.db.patch("billingCustomers", customerRef, { cancellationLastOutcome: "support" });
      return null;
    }
    const { generation, inputRevision, mode, customerId } = customer;
    const old = customer.cancellationProgress;
    const progress: Progress = old?.generation === generation && old.inputRevision === inputRevision ? old : {
      generation, inputRevision, until: now, phase: "subscriptions", page: 0, offset: 0, cursor: null, blocked: false,
    };
    const resources: Infer<typeof resourceValidator>[] = [];
    let nextCursor: string | null = null;
    let localDone = false;
    if (progress.phase === "knownSubscriptions") {
      const page = await ctx.db.query("billingSubscriptions").withIndex("by_customerRef_and_status", q => q.eq("customerRef", customerRef))
        .paginate({ cursor: progress.cursor, numItems: CHUNK });
      for (const row of page.page) resources.push({ subscriptionRef: row._id, subscriptionId: row.subscriptionId });
      nextCursor = page.continueCursor; localDone = page.isDone;
    } else if (progress.phase === "purchases") {
      const page = await ctx.db.query("billingPurchases").withIndex("by_customerRef_and_state", q => q.eq("customerRef", customerRef))
        .paginate({ cursor: progress.cursor, numItems: CHUNK });
      for (const row of page.page) resources.push({ purchaseRef: row._id, state: row.state,
        ...(row.state === "settled" ? { grantProven: await hasPurchaseGrant(ctx, customer, row) } : {}),
        ...(row.sessionId ? { sessionId: row.sessionId } : {}), ...(row.paymentId ? { paymentId: row.paymentId } : {}),
        ...(row.expiresAt === undefined ? {} : { expiresAt: row.expiresAt }) });
      nextCursor = page.continueCursor; localDone = page.isDone;
    }
    const leaseId = crypto.randomUUID();
    await ctx.db.patch("billingCustomers", customerRef, { cancellationLeaseId: leaseId, cancellationLeaseExpiresAt: now + CANCELLATION_LEASE_MS,
      cancellationAttempts: (customer.cancellationAttempts ?? 0) + 1, cancellationProgress: progress, cancellationNextAttemptAt: now + CANCELLATION_LEASE_MS });
    return { generation, inputRevision, mode, ...(customerId ? { customerId } : {}), leaseId, progress, resources, nextCursor, localDone,
      deletedAt: customer.deletedAt };
  },
});

export const recoverCustomer = internalAction({
  args: { customerRef: v.id("billingCustomers") }, returns: v.null(),
  handler: async (ctx, { customerRef }): Promise<null> => {
    const config = readConvexBillingConfig("convex-reconciler");
    if (!config) return null;
    const claim = await ctx.runMutation(internal.billingCancellation.claimCancellation, { customerRef });
    if (!claim || config.environment !== claim.mode) return null;
    const progress: Progress = { ...claim.progress };
    const evidence: Infer<typeof evidenceValidator> = { progress, failed: false, support: !claim.customerId,
      retryAt: 0, ended: [], resolved: [], findings: [] };
    let calls = 0;
    // Counts ALL nested GET/PATCH calls too. No fetch is issued after the cap or lease expiry.
    const started = Date.now();
    const boundedFetch: typeof fetch = async (input, init) => {
      if (calls >= CANCELLATION_FETCH_LIMIT || Date.now() >= started + CANCELLATION_LEASE_MS - 60_000) throw new Error("Cancellation budget exhausted");
      calls++;
      const response = await fetch(input, init);
      if (response.status === 429 || response.status === 503) {
        const value = response.headers.get("retry-after");
        if (value) {
          const at = /^\d+$/.test(value) ? Date.now() + Number(value) * 1000 : Date.parse(value);
          if (Number.isFinite(at)) evidence.retryAt = Math.max(evidence.retryAt, Math.min(at, Date.now() + CANCELLATION_MAX_DELAY_MS));
        }
      }
      return response;
    };
    async function finding(kind: "subscription" | "payment", id: string, status: string) {
      evidence.findings.push({ kind, id, status, bodyDigest: await sha256Hex(new TextEncoder().encode(`poll:${kind}:${id}:${status}`)) });
    }
    async function endSubscription(id: string) {
      const sub = await fetchSubscription(config!, id, boundedFetch);
      if (sub.customerId !== claim!.customerId || sub.productId !== config!.proProductId) { evidence.support = true; evidence.failed = true; return false; }
      let ended = ENDED.has(sub.status);
      if (!ended) {
        const result = await setDodoCancellation({ ...config!, customerId: claim!.customerId! }, { subscriptionId: id, timing: "immediate" }, boundedFetch);
        ended = result.kind === "confirmed" && ENDED.has(result.status);
        if (!ended) evidence.failed = true;
      }
      await finding("subscription", id, ended ? "cancelled" : sub.status);
      return ended;
    }
    function lateCharge(payment: Awaited<ReturnType<typeof fetchPayment>>) {
      const late = payment.status === "succeeded" && payment.createdAt >= claim!.deletedAt - PROVIDER_CLOCK_SKEW_MS;
      if (payment.customerId !== claim!.customerId || late) evidence.support = true;
      return late;
    }
    try {
      if (!evidence.support) {
        const owner = await fetchCustomer(config, claim.customerId!, boundedFetch);
        if (owner.customerId !== claim.customerId || owner.businessId !== config.businessId) evidence.support = true;
      }
      if (!evidence.support && (progress.phase === "subscriptions" || progress.phase === "payments")) {
        const kind = progress.phase;
        const page = await listCustomerResources(config, kind, claim.customerId!, { since: 0, until: progress.until, page: progress.page }, boundedFetch);
        let offset = progress.offset;
        for (const item of page.items.slice(offset, offset + CHUNK)) {
          if (kind === "subscriptions") { if (!await endSubscription(item.id)) break; }
          else {
            const payment = await fetchPayment(config, item.id, boundedFetch);
            if (payment.customerId !== claim.customerId) { evidence.support = true; break; }
            lateCharge(payment);
            await finding("payment", item.id, payment.status);
            // A succeeded late charge needs settlement/refund review. Never auto-refund or infer an empty remainder.
            if (!DEAD_PAYMENT.has(payment.status) && payment.status !== "succeeded") progress.blocked = true;
          }
          offset++;
        }
        progress.offset = offset;
        if (offset >= page.items.length) {
          progress.offset = 0;
          if (page.full) {
            if (progress.page + 1 >= MAX_POLL_PAGES) evidence.support = true;
            else progress.page++;
          } else {
            progress.phase = kind === "subscriptions" ? "knownSubscriptions" : "purchases";
            progress.page = 0; progress.cursor = null;
          }
        }
      } else if (!evidence.support) {
        for (const resource of claim.resources) {
          if (resource.subscriptionId && resource.subscriptionRef) {
            if (!await endSubscription(resource.subscriptionId)) break;
            evidence.ended.push(resource.subscriptionRef);
          } else if (resource.purchaseRef) {
            let safe = false; // A local settled state alone never proves provider charge timing.
            if (resource.sessionId) {
              const session = await fetchCheckoutSession(config, resource.sessionId, boundedFetch);
              const expired = Date.now() >= Math.max(resource.expiresAt ?? 0, session.createdAt + CHECKOUT_SESSION_TTL_MS) + PROVIDER_CLOCK_SKEW_MS;
              safe = expired && (!session.paymentId && !session.paymentStatus || DEAD_PAYMENT.has(session.paymentStatus ?? ""));
              if (session.paymentId) {
                const payment = await fetchPayment(config, session.paymentId, boundedFetch);
                safe = !lateCharge(payment) && expired && payment.customerId === claim.customerId && DEAD_PAYMENT.has(payment.status);
                await finding("payment", session.paymentId, payment.status);
              }
            }
            if (resource.paymentId) {
              const payment = await fetchPayment(config, resource.paymentId, boundedFetch);
              safe = !lateCharge(payment) && payment.customerId === claim.customerId &&
                (resource.state === "settled" && resource.grantProven === true && payment.status === "succeeded" ||
                  DEAD_PAYMENT.has(payment.status) && (!resource.sessionId || safe));
              await finding("payment", resource.paymentId, payment.status);
            }
            if (resource.state === "settled" && !resource.grantProven) { evidence.support = true; safe = false; }
            if (resource.state === "quarantined" || ["unknown", "preparing"].includes(resource.state ?? "") && !resource.sessionId && !resource.paymentId) evidence.support = true;
            if (["unknown", "preparing", "processing", "quarantined"].includes(resource.state ?? "")) safe = false;
            if (!safe) progress.blocked = true;
            else evidence.resolved.push(resource.purchaseRef);
          }
        }
        if (!evidence.failed) {
          progress.cursor = claim.nextCursor;
          if (claim.localDone) {
            progress.phase = progress.phase === "knownSubscriptions" ? "payments" : "done";
            progress.until = Date.now(); progress.cursor = null;
          }
        }
      }
    } catch { evidence.failed = true; }
    await ctx.runMutation(internal.billingCancellation.commitCancellationEvidence, {
      customerRef, generation: claim.generation, inputRevision: claim.inputRevision, leaseId: claim.leaseId, evidence,
    });
    return null;
  },
});

export const commitCancellationEvidence = internalMutation({
  args: { customerRef: v.id("billingCustomers"), generation: v.number(), inputRevision: v.number(), leaseId: v.string(), evidence: evidenceValidator },
  returns: v.union(v.literal("stale"), v.literal("pending"), v.literal("complete")),
  handler: async (ctx, { customerRef, generation, inputRevision, leaseId, evidence }) => {
    const customer = await ctx.db.get("billingCustomers", customerRef);
    const now = Date.now();
    if (!customer || customer.deletedAt === undefined || !customer.cancellationRecoveryRequired || customer.generation !== generation ||
      customer.inputRevision !== inputRevision || customer.cancellationLeaseId !== leaseId || (customer.cancellationLeaseExpiresAt ?? 0) <= now) return "stale";
    const previous = customer.cancellationProgress;
    if (!previous || evidence.progress.generation !== generation || evidence.progress.inputRevision !== inputRevision) return "stale";
    const nextPhase = { subscriptions: "knownSubscriptions", knownSubscriptions: "payments", payments: "purchases", purchases: "done", done: "done" };
    if (evidence.progress.phase !== previous.phase && evidence.progress.phase !== nextPhase[previous.phase]) return "stale";
    if (previous.blocked) evidence.progress.blocked = true;
    // Re-read the exact local page before accepting clearance/advancement. Earlier pages are fenced by inputRevision.
    if (!evidence.failed && (previous.phase === "knownSubscriptions" || previous.phase === "purchases")) {
      const opts = { cursor: previous.cursor, numItems: CHUNK };
      if (previous.phase === "knownSubscriptions") {
        const page = await ctx.db.query("billingSubscriptions").withIndex("by_customerRef_and_status", q => q.eq("customerRef", customerRef)).paginate(opts);
        if (page.page.some(row => !evidence.ended.includes(row._id))) evidence.progress.blocked = true;
        if (evidence.progress.phase !== previous.phase && !page.isDone) return "stale";
      } else {
        const page = await ctx.db.query("billingPurchases").withIndex("by_customerRef_and_state", q => q.eq("customerRef", customerRef)).paginate(opts);
        if (page.page.some(row => !evidence.resolved.includes(row._id))) evidence.progress.blocked = true;
        if (evidence.progress.phase !== previous.phase && !page.isDone) return "stale";
      }
    }
    if (evidence.findings.length > 6 || evidence.ended.length > CHUNK || evidence.resolved.length > CHUNK) return "stale";
    for (const finding of evidence.findings) {
      if (finding.kind === "payment" && finding.status === "succeeded") {
        const bound = await ctx.db.query("billingPurchases").withIndex("by_mode_and_paymentId", q =>
          q.eq("mode", customer.mode).eq("paymentId", finding.id)).unique();
        if (bound?.customerRef === customerRef && bound.state === "settled") {
          if (!await hasPurchaseGrant(ctx, customer, bound)) { evidence.support = true; evidence.progress.blocked = true; }
          continue;
        }
        evidence.progress.blocked = true;
      }
      await recordReceiptRow(ctx, { customerRef, mode: customer.mode, webhookId: `poll:${finding.kind}:${finding.id}:${finding.status}`,
        eventType: `${finding.kind}.poll`, bodyDigest: finding.bodyDigest, occurredAt: now,
        ...(finding.kind === "subscription" ? { subscriptionId: finding.id } : { paymentId: finding.id }) });
    }
    // Receipt recording may itself reopen an obligation. Never overwrite its newer revision.
    const fresh = await ctx.db.get("billingCustomers", customerRef);
    if (fresh?.inputRevision !== inputRevision) {
      await ctx.db.patch("billingCustomers", customerRef, { cancellationNextAttemptAt: customer.cancellationLeaseExpiresAt });
      return "stale";
    }
    for (const ref of evidence.ended) {
      const row = await ctx.db.get("billingSubscriptions", ref);
      if (row?.customerRef !== customerRef || row.mode !== customer.mode) return "stale";
      if (row.controlPendingAt !== undefined) { evidence.progress.blocked = true; continue; }
      await ctx.db.patch("billingSubscriptions", ref, { status: row.status === "expired" ? "expired" : "cancelled", cancellationRecoveryRequired: false });
    }
    for (const ref of evidence.resolved) {
      const row = await ctx.db.get("billingPurchases", ref);
      if (row?.customerRef !== customerRef || row.mode !== customer.mode) return "stale";
      if (row.state === "settled" && !await hasPurchaseGrant(ctx, customer, row)) { evidence.support = true; continue; }
      await ctx.db.patch("billingPurchases", ref, { state: row.state === "settled" ? "settled" : "terminal", cancellationRecoveryRequired: false });
    }
    let leftover = false;
    if (evidence.progress.phase === "done") {
      // Status/state cursors can move beneath us. Recheck all child markers under a hard read bound.
      const subs = await ctx.db.query("billingSubscriptions").withIndex("by_customerRef_and_status", q => q.eq("customerRef", customerRef)).take(LOCAL_PROOF_LIMIT + 1);
      const purchases = await ctx.db.query("billingPurchases").withIndex("by_customerRef_and_state", q => q.eq("customerRef", customerRef)).take(LOCAL_PROOF_LIMIT + 1);
      evidence.support ||= subs.length > LOCAL_PROOF_LIMIT || purchases.length > LOCAL_PROOF_LIMIT;
      for (const purchase of purchases) {
        if (purchase.state === "settled" && !await hasPurchaseGrant(ctx, customer, purchase)) evidence.support = true;
      }
      leftover = subs.some(row => row.cancellationRecoveryRequired || row.controlPendingAt !== undefined || !["cancelled", "expired"].includes(row.status)) ||
        purchases.some(row => row.cancellationRecoveryRequired || !["settled", "terminal"].includes(row.state));
    }
    const complete = evidence.progress.phase === "done" && !evidence.progress.blocked && !evidence.failed && !evidence.support &&
      !leftover && !!customer.customerId && customer.unresolvedReceipts === 0 && !customer.pendingPurchaseRef;
    const retry = evidence.failed || evidence.progress.phase === "done" && !complete && !evidence.support;
    const attempts = retry ? (customer.cancellationAttempts ?? 1) : 0;
    const support = evidence.support || attempts >= CANCELLATION_MAX_ATTEMPTS;
    // Re-read temporary blockers on a new pass; successful intermediate chunks preserve the retry budget.
    const savedAttempts = retry || support ? attempts : Math.max(0, (customer.cancellationAttempts ?? 1) - 1);
    await ctx.db.patch("billingCustomers", customerRef, {
      cancellationLeaseId: undefined, cancellationLeaseExpiresAt: undefined, cancellationAttempts: savedAttempts,
      cancellationProgress: retry && evidence.progress.phase === "done" ? undefined : evidence.failed ? customer.cancellationProgress : evidence.progress,
      cancellationRecoveryRequired: !complete, cancellationLastOutcome: complete ? "complete" : support ? "support" : retry ? "retry" : "pending",
      cancellationNextAttemptAt: complete ? undefined : Math.max(Math.min(evidence.retryAt, now + CANCELLATION_MAX_DELAY_MS), now + (support ? CANCELLATION_MAX_DELAY_MS :
        Math.min(CANCELLATION_MAX_DELAY_MS, CANCELLATION_BASE_DELAY_MS * 2 ** savedAttempts))),
    });
    return complete ? "complete" : "pending";
  },
});
