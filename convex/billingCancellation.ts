import { v, type Infer } from "convex/values";

import { fetchCheckoutSession, fetchPayment, fetchSubscription, listCustomerResources } from "../src/features/billing/server/dodo-reads";
import { readBoundedBody } from "../src/features/billing/server/bounded-body";
import { setDodoCancellation } from "../src/features/billing/server/dodo-subscription";
import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import { recordReceiptRow } from "./billing";
import { readConvexBillingConfig } from "./billingEnv";
import { CHECKOUT_SESSION_TTL_MS, PROVIDER_CLOCK_SKEW_MS, MAX_POLL_PAGES } from "./billingPoll";
import { sha256Hex } from "./billingWebhook";
import { billingCancellationProgressValidator, billingModeValidator } from "./schema";

export const CANCELLATION_BATCH = 5;
export const CANCELLATION_FETCH_LIMIT = 20;
export const CANCELLATION_MAX_ATTEMPTS = 8;
export const CANCELLATION_BASE_DELAY_MS = 15 * 60_000;
export const CANCELLATION_MAX_DELAY_MS = 24 * 60 * 60_000;
export const CANCELLATION_LEASE_MS = 10 * 60_000;
const CHUNK = 3; // A subscription read + the adapter's five nested calls, three times, plus one list = 19.
const ENDED = new Set(["cancelled", "expired", "failed"]);
const DEAD_PAYMENT = new Set(["failed", "cancelled"]);
type Progress = Infer<typeof billingCancellationProgressValidator>;
const resourceValidator = v.object({
  subscriptionRef: v.optional(v.id("billingSubscriptions")), purchaseRef: v.optional(v.id("billingPurchases")),
  subscriptionId: v.optional(v.string()), sessionId: v.optional(v.string()), paymentId: v.optional(v.string()),
  state: v.optional(v.string()), expiresAt: v.optional(v.number()),
});
const findingValidator = v.object({
  kind: v.union(v.literal("subscription"), v.literal("payment")), id: v.string(), status: v.string(), bodyDigest: v.string(),
});
const evidenceValidator = v.object({
  progress: billingCancellationProgressValidator, failed: v.boolean(), support: v.boolean(), retryAt: v.number(),
  ended: v.array(v.id("billingSubscriptions")), resolved: v.array(v.id("billingPurchases")), findings: v.array(findingValidator),
});

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
      await ctx.db.patch("billingCustomers", row._id, { cancellationNextAttemptAt: now + CANCELLATION_MAX_DELAY_MS });
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
    uncertainCreate: v.boolean(),
  })),
  handler: async (ctx, { customerRef }) => {
    const customer = await ctx.db.get("billingCustomers", customerRef);
    const now = Date.now();
    if (!customer || customer.deletedAt === undefined || !customer.cancellationRecoveryRequired ||
      customer.cancellationLastOutcome === "support" || (customer.cancellationLeaseExpiresAt ?? 0) > now) return null;
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
        ...(row.sessionId ? { sessionId: row.sessionId } : {}), ...(row.paymentId ? { paymentId: row.paymentId } : {}),
        ...(row.expiresAt === undefined ? {} : { expiresAt: row.expiresAt }) });
      nextCursor = page.continueCursor; localDone = page.isDone;
    }
    const leaseId = crypto.randomUUID();
    await ctx.db.patch("billingCustomers", customerRef, { cancellationLeaseId: leaseId, cancellationLeaseExpiresAt: now + CANCELLATION_LEASE_MS,
      cancellationAttempts: (customer.cancellationAttempts ?? 0) + 1, cancellationProgress: progress, cancellationNextAttemptAt: now + CANCELLATION_LEASE_MS });
    return { generation, inputRevision, mode, ...(customerId ? { customerId } : {}), leaseId, progress, resources, nextCursor, localDone,
      uncertainCreate: customer.creationState !== "ready" };
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
    const evidence: Infer<typeof evidenceValidator> = { progress, failed: false, support: claim.uncertainCreate || !claim.customerId,
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
          if (Number.isFinite(at)) evidence.retryAt = Math.max(evidence.retryAt, at);
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
    try {
      if (!evidence.support) {
        const host = config.environment === "test_mode" ? "https://test.dodopayments.com" : "https://live.dodopayments.com";
        const response = await boundedFetch(`${host}/customers/${claim.customerId}`, { method: "GET", redirect: "manual",
          headers: { Authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(15_000) });
        const bytes = response.ok ? await readBoundedBody(response, 256 * 1024) : null;
        if (!bytes) throw new Error("Customer ownership unavailable");
        const owner = JSON.parse(new TextDecoder().decode(bytes)) as { customer_id?: unknown; business_id?: unknown };
        if (owner.customer_id !== claim.customerId || owner.business_id !== config.businessId) evidence.support = true;
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
            let safe = resource.state === "settled";
            if (resource.sessionId) {
              const session = await fetchCheckoutSession(config, resource.sessionId, boundedFetch);
              const expired = Date.now() >= Math.max(resource.expiresAt ?? 0, session.createdAt + CHECKOUT_SESSION_TTL_MS) + PROVIDER_CLOCK_SKEW_MS;
              safe = expired && (!session.paymentId && !session.paymentStatus || DEAD_PAYMENT.has(session.paymentStatus ?? ""));
              if (session.paymentId) {
                const payment = await fetchPayment(config, session.paymentId, boundedFetch);
                safe = expired && payment.customerId === claim.customerId && DEAD_PAYMENT.has(payment.status);
                await finding("payment", session.paymentId, payment.status);
              }
            }
            if (resource.paymentId) {
              const payment = await fetchPayment(config, resource.paymentId, boundedFetch);
              safe = payment.customerId === claim.customerId &&
                (resource.state === "settled" && payment.status === "succeeded" ||
                  DEAD_PAYMENT.has(payment.status) && (!resource.sessionId || safe));
              await finding("payment", resource.paymentId, payment.status);
            }
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
        if (bound?.customerRef === customerRef && bound.state === "settled") continue;
        evidence.progress.blocked = true;
      }
      await recordReceiptRow(ctx, { customerRef, mode: customer.mode, webhookId: `poll:${finding.kind}:${finding.id}:${finding.status}`,
        eventType: `${finding.kind}.poll`, bodyDigest: finding.bodyDigest, occurredAt: now,
        ...(finding.kind === "subscription" ? { subscriptionId: finding.id } : { paymentId: finding.id }) });
    }
    // Receipt recording may itself reopen an obligation. Never overwrite its newer revision.
    const fresh = await ctx.db.get("billingCustomers", customerRef);
    if (fresh?.inputRevision !== inputRevision) return "stale";
    for (const ref of evidence.ended) {
      const row = await ctx.db.get("billingSubscriptions", ref);
      if (row?.customerRef !== customerRef || row.mode !== customer.mode) return "stale";
      await ctx.db.patch("billingSubscriptions", ref, { cancellationRecoveryRequired: false });
    }
    for (const ref of evidence.resolved) {
      const row = await ctx.db.get("billingPurchases", ref);
      if (row?.customerRef !== customerRef || row.mode !== customer.mode) return "stale";
      await ctx.db.patch("billingPurchases", ref, { cancellationRecoveryRequired: false });
    }
    const attempts = evidence.failed ? (customer.cancellationAttempts ?? 1) : 0;
    const complete = evidence.progress.phase === "done" && !evidence.progress.blocked && !evidence.failed && !evidence.support &&
      customer.creationState === "ready" && !!customer.customerId && customer.unresolvedReceipts === 0 && !customer.pendingPurchaseRef;
    const support = evidence.support || attempts >= CANCELLATION_MAX_ATTEMPTS || evidence.progress.phase === "done" && !complete;
    await ctx.db.patch("billingCustomers", customerRef, {
      cancellationLeaseId: undefined, cancellationLeaseExpiresAt: undefined, cancellationAttempts: attempts,
      cancellationProgress: evidence.failed ? customer.cancellationProgress : evidence.progress,
      cancellationRecoveryRequired: !complete, cancellationLastOutcome: complete ? "complete" : support ? "support" : evidence.failed ? "retry" : "pending",
      cancellationNextAttemptAt: complete ? undefined : Math.max(evidence.retryAt, now + (support ? CANCELLATION_MAX_DELAY_MS :
        Math.min(CANCELLATION_MAX_DELAY_MS, CANCELLATION_BASE_DELAY_MS * 2 ** attempts))),
    });
    return complete ? "complete" : "pending";
  },
});
