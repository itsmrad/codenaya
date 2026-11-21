import { v, type Infer } from "convex/values";

import { currentUsage } from "../src/features/billing/credits";
import { currentFreeAllocation } from "../src/features/billing/free-allocation";
import { topUpExpiresAt } from "../src/features/billing/grants";
import { BILLING_CATALOG_VERSION } from "../src/features/billing/settlement";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { assertGrantFence, associateUnmappedReceipts, bindSubscriptionRow, ownerDeleted } from "./billing";
import { insertGrant, rollOverIntoPeriod } from "./billingGrants";
import { markPollDue } from "./billingPoll";
import { MAX_RECEIPTS_PER_CLAIM } from "./billingQueue";
import { applyPurchaseReversal, queuePaymentRead, recordAdjustments, reversalDecisionValidator } from "./billingReversals";

/**
 * Fenced fulfillment of reconciled Dodo facts (ADR 0016). One transaction settles each
 * payment and its grant together, projects subscriptions and marks receipts. A business
 * outcome never throws: that would roll back the batch's other outcomes. Positives
 * (grants for a live owner) commit only under an unchanged fence, with a known reversal
 * for their payment and no unresolved refund or dispute for the customer outside this
 * commit; pending positives left for later claims never block. Every payment's refunds
 * and disputes are applied right after its settlement, in the same transaction.
 */

export const MAX_UNMAPPED_CHECK = 20;
export const MAX_SUBSCRIPTIONS_PER_STATUS = 10;
// Every status that can carry paidThrough: a cancelled subscription stays paid until its period ends.
const PAID_STATUSES = ["active", "cancelled", "expired", "quarantined"] as const;
const NEGATIVE_PREFIXES = ["refund.", "dispute."];
const NEGATIVE_EVENT = /^(refund|dispute)\./;
const PROVIDER_EVENT = /^(payment|subscription)\./;

export const settlementDecisionValidator = v.union(
  v.object({
    kind: v.literal("period"), paymentId: v.string(), subscriptionId: v.string(), productId: v.string(),
    serviceStart: v.number(), serviceEnd: v.number(), credits: v.number(), settledAt: v.number(),
  }),
  v.object({ kind: v.literal("top_up"), paymentId: v.string(), productId: v.string(), credits: v.number(), settledAt: v.number() }),
  v.object({ kind: v.union(v.literal("pending"), v.literal("no_grant"), v.literal("quarantine")), paymentId: v.string(), reason: v.string() }),
  v.object({ kind: v.literal("processing"), paymentId: v.string() }),
);

export const subscriptionFactValidator = v.object({
  subscriptionId: v.string(), customerId: v.string(), productId: v.string(), quantity: v.optional(v.number()),
  status: v.string(), previousBillingAt: v.optional(v.number()), nextBillingAt: v.optional(v.number()),
  cancelAtNextBillingDate: v.boolean(),
});

const paymentFactValidator = v.object({
  paymentId: v.string(), decision: settlementDecisionValidator, sessionId: v.optional(v.string()),
  purchaseIdHint: v.optional(v.string()),
  currency: v.optional(v.string()), totalMinor: v.optional(v.number()), taxMinor: v.optional(v.number()),
  reversal: reversalDecisionValidator,
});

type Ctx = MutationCtx;
type Customer = Doc<"billingCustomers">;
type Purchase = Doc<"billingPurchases">;
export type PaymentFact = Infer<typeof paymentFactValidator>;
type SubscriptionFact = Infer<typeof subscriptionFactValidator>;
type Positive = Extract<PaymentFact["decision"], { kind: "period" | "top_up" }>;
type Period = Extract<Positive, { kind: "period" }>;
/** What happens to a receipt: final and done, final for support, or retried. */
type Outcome = "processed" | "quarantined" | "pending";
type PaymentPlan = { fact: PaymentFact; purchase: Purchase | null; outcome: Outcome; positive: boolean };
type SubscriptionPlan = { fact: SubscriptionFact; outcome: Outcome };

const subscriptionRow = (ctx: Ctx, mode: Customer["mode"], subscriptionId: string) => ctx.db.query("billingSubscriptions")
  .withIndex("by_mode_and_subscriptionId", q => q.eq("mode", mode).eq("subscriptionId", subscriptionId)).unique();

async function findPurchase(ctx: Ctx, customer: Customer, { paymentId, sessionId, purchaseIdHint, decision }: PaymentFact) {
  const mode = customer.mode;
  const byPayment = await ctx.db.query("billingPurchases")
    .withIndex("by_mode_and_paymentId", q => q.eq("mode", mode).eq("paymentId", paymentId)).unique();
  if (byPayment) return byPayment;
  if (sessionId) {
    const bySession = await ctx.db.query("billingPurchases")
      .withIndex("by_mode_and_sessionId", q => q.eq("mode", mode).eq("sessionId", sessionId)).unique();
    if (bySession) return bySession.paymentId === undefined ? bySession : null;
  }
  if (!purchaseIdHint || (decision.kind !== "period" && decision.kind !== "top_up")) return null;
  const pending = customer.pendingPurchaseRef && await ctx.db.get("billingPurchases", customer.pendingPurchaseRef);
  if (pending?.intentId === purchaseIdHint) {
    return pending.customerRef === customer._id && pending.mode === mode &&
      ["unknown", "preparing"].includes(pending.state) && pending.sessionId === undefined &&
      pending.paymentId === undefined && termsMatch(pending, decision) ? pending : null;
  }
  // A released intent may have no session id and a newer checkout may now hold the lock.
  const released = await ctx.db.query("billingPurchases")
    .withIndex("by_mode_and_intentId", q => q.eq("mode", mode).eq("intentId", purchaseIdHint)).unique();
  return released && released.customerRef === customer._id && released.mode === mode &&
    ["open", "terminal", "unknown"].includes(released.state) && released.paymentId === undefined &&
    termsMatch(released, decision) ? released : null;
}

async function planPayment(ctx: Ctx, customer: Customer, fact: PaymentFact, deleted: boolean): Promise<PaymentPlan> {
  const { decision: d } = fact;
  const found = await findPurchase(ctx, customer, fact);
  // Another customer's purchase is never written from this customer's commit.
  const foreign = found !== null && found.customerRef !== customer._id;
  const plan = { fact, purchase: foreign ? null : found, positive: false };
  switch (d.kind) {
    case "pending": return { ...plan, outcome: "pending" };
    case "processing": case "no_grant": return { ...plan, outcome: "processed" };
    case "quarantine":
      if (plan.purchase?.paymentId === d.paymentId && plan.purchase.state !== "settled") return { ...plan, outcome: "processed" };
      // A zero-amount charge with no purchase of its own never mints: final. A positive total with a bad
      // currency is a real payment, so it stays quarantined and visible.
      return { ...plan, outcome: d.reason === "amount" && fact.totalMinor !== undefined && fact.totalMinor <= 0 ? "processed" : "quarantined" };
  }
  if (foreign) {
    // Final: it can never grant this customer anything, so it must not hold their fence.
    console.error("[billingFulfill] payment matches another customer's purchase", { customerRef: customer._id, paymentId: d.paymentId });
    return { ...plan, outcome: "processed" };
  }
  // Keep verified gross even when a bound payment cannot grant yet; never derive it from principal.
  if (plan.purchase?.paymentId === fact.paymentId && plan.purchase.totalMinor === undefined &&
    Number.isSafeInteger(fact.totalMinor) && fact.totalMinor! > 0) {
    await ctx.db.patch("billingPurchases", plan.purchase._id, { totalMinor: fact.totalMinor });
  }
  if (fact.reversal.kind === "unknown") {
    const review = plan.purchase?.reviewedReversalRef && await ctx.db.get("billingEvents", plan.purchase.reviewedReversalRef);
    if (!review || review.customerRef !== customer._id || review.mode !== customer.mode ||
      review.paymentId !== fact.paymentId || review.state !== "processed" ||
      review.resolution?.action !== "resolveUnreadableReversal" || review.reviewedReversalMinor === undefined ||
      fact.totalMinor === undefined || (plan.purchase?.totalMinor !== undefined && plan.purchase.totalMinor !== fact.totalMinor) ||
      (review.reviewedReversalMinor ?? 0) > fact.totalMinor) return { ...plan, outcome: "pending" };
    // Only the payment retry uses the reviewed cumulative amount already kept on the purchase.
    // Receipt outcomes still use the raw facts, so a new unreadable negative remains fenced.
    plan.fact = { ...fact, reversal: { kind: "known", refunds: [], disputes: [] } };
  }
  return { ...plan, outcome: "processed", positive: !deleted };
}

async function planSubscription(ctx: Ctx, customer: Customer, fact: SubscriptionFact): Promise<SubscriptionPlan> {
  const row = await subscriptionRow(ctx, customer.mode, fact.subscriptionId);
  const foreign = fact.customerId !== customer.customerId || (row !== null && row.customerRef !== customer._id);
  return { fact, outcome: foreign ? "quarantined" : "processed" };
}

const isMismatch = ({ decision: d }: PaymentFact) => d.kind === "quarantine" && d.reason === "customer_mismatch";

/** A refund or dispute receipt is final once its payment's reversal is known; another customer's payment is for support. */
const reversalOutcome = (fact: PaymentFact): Outcome =>
  isMismatch(fact) ? "quarantined" : fact.reversal.kind === "known" && fact.totalMinor !== undefined ? "processed" : "pending";

/** A receipt is final only when every resource it names reached a final outcome. */
function receiptOutcome(
  receipt: Doc<"billingEvents">, payments: Map<string, Outcome>, subscriptions: Map<string, Outcome>, reversals: Map<string, Outcome>,
): Outcome {
  if (NEGATIVE_EVENT.test(receipt.eventType)) return (receipt.paymentId && reversals.get(receipt.paymentId)) || "pending";
  if (!PROVIDER_EVENT.test(receipt.eventType)) return "processed"; // a redriven unsupported type
  const parts = [
    receipt.paymentId === undefined ? "processed" : payments.get(receipt.paymentId) ?? "pending",
    receipt.subscriptionId === undefined ? "processed" : subscriptions.get(receipt.subscriptionId) ?? "pending",
  ];
  return parts.includes("pending") ? "pending" : parts.includes("quarantined") ? "quarantined" : "processed";
}

/**
 * Whether positives may commit; decided before any grant. The fence itself is checked by the caller.
 * A positive's payment read showed this customer, so its unmapped receipts are attached first; any
 * attachment moves the fence and adds unresolved receipts, so no positive commits in this transaction.
 */
async function positivesMayCommit(ctx: Ctx, customer: Customer, plans: PaymentPlan[], resolved: Set<Id<"billingEvents">>) {
  let attached = 0;
  for (const { fact } of plans.filter(plan => plan.positive)) {
    attached += await associateUnmappedReceipts(ctx, customer, { paymentId: fact.paymentId });
  }
  if (attached || customer.hold) return false;
  const account = await ctx.db.query("creditAccounts").withIndex("by_userId", q => q.eq("userId", customer.userId)).unique();
  if (account?.paidCreditsMode !== undefined && account.paidCreditsMode !== customer.mode) return false;
  // Any refund or dispute of this customer that is unresolved (pending, processing, dead-lettered, collided) blocks,
  // unless this commit resolves it. "processing" is never written for receipts today; it is read anyway so a future
  // writer cannot bypass this. Past the bound one may be unread: fail closed.
  for (const state of ["pending", "processing", "quarantined"] as const) {
    for (const prefix of NEGATIVE_PREFIXES) {
      const negatives = await ctx.db.query("billingEvents").withIndex("by_customerRef_and_state_and_eventType", q =>
        q.eq("customerRef", customer._id).eq("state", state).gte("eventType", prefix).lt("eventType", `${prefix.slice(0, -1)}/`))
        .take(MAX_RECEIPTS_PER_CLAIM + 1);
      if (negatives.length > MAX_RECEIPTS_PER_CLAIM || negatives.some(row => !resolved.has(row._id))) return false;
    }
  }
  for (const { fact } of plans.filter(plan => plan.positive)) {
    const rows = await ctx.db.query("billingEvents")
      .withIndex("by_mode_and_paymentId_and_state", q => q.eq("mode", customer.mode).eq("paymentId", fact.paymentId).eq("state", "quarantined"))
      .take(MAX_UNMAPPED_CHECK);
    // A full read may hide an unmapped negative: fail closed.
    if (rows.length === MAX_UNMAPPED_CHECK || rows.some(row => row.customerRef === undefined && NEGATIVE_EVENT.test(row.eventType))) return false;
  }
  return true;
}

/** Turns paid credits on, storing this month's Free state now: paid usage later raises the legacy counters. */
async function enableAccount(ctx: Ctx, customer: Customer, now: number) {
  const account = await ctx.db.query("creditAccounts").withIndex("by_userId", q => q.eq("userId", customer.userId)).unique();
  if (account?.paidCreditsVersion !== undefined) return;
  const { allocation } = currentFreeAllocation(account, 0, now);
  const fields = {
    paidCreditsVersion: 1 as const, paidCreditsMode: customer.mode,
    freeMonthStartsAt: allocation.monthStartsAt, freeUsed: allocation.used, freeDebtOffset: allocation.debtOffset,
  };
  // Never sets plan "pro": the plan projection and send gates come later.
  if (account) await ctx.db.patch("creditAccounts", account._id, fields);
  else await ctx.db.insert("creditAccounts", { userId: customer.userId, plan: "free", ...currentUsage(null, now), ...fields });
}

/** A replay only raises paidThrough: it never reactivates a cancelled or expired row. */
async function projectPeriod(ctx: Ctx, customer: Customer, d: Period, now: number, replay: boolean) {
  const ref = await bindSubscriptionRow(ctx, { customerRef: customer._id, mode: customer.mode, subscriptionId: d.subscriptionId, productId: d.productId });
  const row = (await ctx.db.get("billingSubscriptions", ref))!;
  // paidThrough never shrinks; an old period applied late leaves the current state alone.
  const latest = !replay && d.serviceEnd >= (row.paidThrough ?? 0);
  await ctx.db.patch("billingSubscriptions", ref, {
    paidThrough: Math.max(row.paidThrough ?? 0, d.serviceEnd), observedAt: now,
    ...(latest ? { status: "active" as const, serviceStart: d.serviceStart, serviceEnd: d.serviceEnd } : {}),
  });
  if (latest) await ctx.db.patch("billingCustomers", customer._id, { activeSubscriptionRef: ref });
}

const termsMatch = (purchase: Purchase, d: Positive) =>
  purchase.terms.sku === (d.kind === "period" ? "pro_monthly" : "top_up") && purchase.terms.productId === d.productId &&
  (d.kind !== "period" || purchase.subscriptionId === undefined || purchase.subscriptionId === d.subscriptionId);

async function quarantinePurchase(ctx: Ctx, purchase: Purchase, paymentId: string, reason: string) {
  await ctx.db.patch("billingPurchases", purchase._id, { state: "quarantined", ...(purchase.paymentId ? {} : { paymentId }) });
  console.error("[billingFulfill] purchase quarantined", { purchaseRef: purchase._id, paymentId, reason });
}

/** A server-created renewal for an owned subscription; anything else is recorded quarantined for support. */
async function createPurchase(ctx: Ctx, customer: Customer, d: Positive, owned: boolean, deleted: boolean, reason: string) {
  const terms = {
    sku: d.kind === "period" ? "pro_monthly" as const : "top_up" as const,
    catalogVersion: BILLING_CATALOG_VERSION, productId: d.productId, quantity: 1, credits: d.credits,
  };
  const ref = await ctx.db.insert("billingPurchases", {
    customerRef: customer._id, mode: customer.mode, intentId: `${owned ? "renewal" : "unmatched"}:${d.paymentId}`, terms,
    paymentId: d.paymentId, ...(d.kind === "period" ? { subscriptionId: d.subscriptionId } : {}),
    state: owned ? "open" : "quarantined", ...(deleted ? { cancellationRecoveryRequired: true } : {}),
  });
  if (!owned) console.error("[billingFulfill] purchase quarantined", { purchaseRef: ref, paymentId: d.paymentId, reason });
  return (await ctx.db.get("billingPurchases", ref))!;
}

/** A grant for this business key from another purchase, or another subscription still paid through the period. */
async function isDuplicate(ctx: Ctx, customer: Customer, d: Positive, purchase: Purchase, sourceKey: string) {
  const grant = await ctx.db.query("billingGrants")
    .withIndex("by_mode_and_sourceKey", q => q.eq("mode", customer.mode).eq("sourceKey", sourceKey)).unique();
  if (grant && grant.purchaseRef !== purchase._id) return true;
  if (d.kind !== "period") return false;
  for (const status of PAID_STATUSES) {
    const rows = await ctx.db.query("billingSubscriptions")
      .withIndex("by_customerRef_and_status", q => q.eq("customerRef", customer._id).eq("status", status))
      .take(MAX_SUBSCRIPTIONS_PER_STATUS + 1);
    // Past the bound an overlapping subscription may be unread: fail closed for support.
    if (rows.length > MAX_SUBSCRIPTIONS_PER_STATUS) return true;
    if (rows.some(row => row.subscriptionId !== d.subscriptionId && (row.paidThrough ?? 0) > d.serviceStart)) return true;
  }
  return false;
}

/** Settles one positive payment with its grant. Returns whether a grant was inserted. */
async function settle(ctx: Ctx, customer: Customer, plan: PaymentPlan, d: Positive, deleted: boolean, now: number) {
  const row = d.kind === "period" ? await subscriptionRow(ctx, customer.mode, d.subscriptionId) : null;
  const rowMismatch = row !== null && (row.customerRef !== customer._id || row.productId !== d.productId);
  // Re-read: an earlier payment in this commit may already have settled this checkout.
  const current = plan.purchase && await ctx.db.get("billingPurchases", plan.purchase._id);
  const taken = current?.paymentId !== undefined && current.paymentId !== d.paymentId;
  // A renewal that carries its checkout's session is still owned; the source key catches a same-period duplicate.
  const purchase = current && !taken ? current
    : await createPurchase(ctx, customer, d, row !== null && !rowMismatch, deleted, taken ? "duplicate_checkout" : "no_purchase");
  if (purchase.state === "quarantined") return false;
  // A replay: one grant per payment, even if a later read reports another period.
  if (purchase.state === "settled") {
    if (d.kind === "period" && !deleted && !rowMismatch) await projectPeriod(ctx, customer, d, now, true);
    return false;
  }
  const sourceKey = d.kind === "period" ? `period:${d.subscriptionId}:${d.serviceStart}:${d.serviceEnd}` : `top_up:${d.paymentId}:0`;
  const reason = rowMismatch ? "subscription_mismatch" : !termsMatch(purchase, d) ? "terms"
    : !deleted && await isDuplicate(ctx, customer, d, purchase, sourceKey) ? "duplicate" : null;
  if (reason) {
    await quarantinePurchase(ctx, purchase, d.paymentId, reason);
    return false;
  }
  const { fact } = plan;
  await ctx.db.patch("billingPurchases", purchase._id, {
    paymentId: d.paymentId, state: "settled", currency: fact.currency,
    ...(fact.totalMinor !== undefined ? { totalMinor: fact.totalMinor } : {}),
    ...(plan.purchase && fact.purchaseIdHint === purchase.intentId && purchase.sessionId === undefined &&
      fact.sessionId !== undefined ? { sessionId: fact.sessionId } : {}),
    ...(d.kind === "period" ? { subscriptionId: d.subscriptionId } : {}),
    ...(fact.totalMinor !== undefined && fact.taxMinor !== undefined ? { principalMinor: fact.totalMinor - fact.taxMinor } : {}),
    ...(deleted ? { cancellationRecoveryRequired: true } : {}),
  });
  if (customer.pendingPurchaseRef === purchase._id) await ctx.db.patch("billingCustomers", customer._id, { pendingPurchaseRef: undefined });
  // Polled for a while after any settlement, top-ups too, so a missed refund or dispute is still found.
  await markPollDue(ctx, customer._id, true);
  if (deleted) return false; // recorded for recovery; no credit account is created or enabled
  // Before insertGrant, so the new grant pays off the enabled account's debt.
  await enableAccount(ctx, customer, now);
  // The purchase's immutable terms, not today's catalog, set the amount.
  const terms = { mode: customer.mode, sourceKey, customerRef: customer._id, purchaseRef: purchase._id, quantity: purchase.terms.credits };
  if (d.kind === "top_up") {
    await insertGrant(ctx, { ...terms, kind: "top_up", expiresAt: topUpExpiresAt(d.settledAt) });
    return true;
  }
  // An already-expired period is still inserted for audit; it is never spendable.
  const grantRef = await insertGrant(ctx, {
    ...terms, kind: "current_period", expiresAt: d.serviceEnd, serviceStart: d.serviceStart, serviceEnd: d.serviceEnd,
  });
  await rollOverIntoPeriod(ctx, grantRef, now);
  await projectPeriod(ctx, customer, d, now, false);
  return true;
}

async function applyPayment(ctx: Ctx, customer: Customer, plan: PaymentPlan, deleted: boolean, now: number) {
  const { decision: d } = plan.fact;
  if (d.kind === "period" || d.kind === "top_up") return await settle(ctx, customer, plan, d, deleted, now);
  const purchase = plan.purchase && await ctx.db.get("billingPurchases", plan.purchase._id);
  // Only a settlement binds a payment to a checkout: a failed attempt leaves the session to its retry.
  if (purchase?.paymentId !== d.paymentId) return false;
  if (d.kind === "quarantine") {
    if (purchase.state !== "settled") await quarantinePurchase(ctx, purchase, d.paymentId, d.reason);
  } else if (d.kind === "processing" && ["preparing", "unknown", "open"].includes(purchase.state)) {
    await ctx.db.patch("billingPurchases", purchase._id, { state: "processing" });
  } else if (d.kind === "no_grant" && (d.reason === "failed" || d.reason === "cancelled") && !["settled", "quarantined", "terminal"].includes(purchase.state)) {
    // The checkout lock (pendingPurchaseRef) is released by a later stage, not here.
    await ctx.db.patch("billingPurchases", purchase._id, { state: "terminal" });
  }
  return false;
}

/**
 * Records a known reversal and applies it to the payment's purchase, re-read because settlement in this
 * commit may have just bound or created it. Another customer's facts or purchase are never written.
 */
async function applyReversal(ctx: Ctx, customer: Customer, fact: PaymentFact, deleted: boolean, now: number) {
  const { reversal, totalMinor, paymentId } = fact;
  if (reversalOutcome(fact) !== "processed" || reversal.kind !== "known" || totalMinor === undefined) return;
  const purchase = await ctx.db.query("billingPurchases")
    .withIndex("by_mode_and_paymentId", q => q.eq("mode", customer.mode).eq("paymentId", paymentId)).unique();
  const owned = purchase?.customerRef === customer._id ? purchase : null;
  if (purchase && !owned) console.error("[billingFulfill] reversal for another customer's purchase", { customerRef: customer._id, paymentId });
  const reversed = await recordAdjustments(ctx, customer, paymentId, reversal, totalMinor, owned?._id, now);
  if (owned) await applyPurchaseReversal(ctx, customer, owned, reversed, totalMinor, deleted);
}

const ENDED_STATUS = new Map([["cancelled", "cancelled"], ["expired", "expired"], ["failed", "expired"]] as const);

async function applySubscription(ctx: Ctx, customer: Customer, { fact, outcome }: SubscriptionPlan, now: number) {
  // Re-read: fulfillment in this commit may have just bound the row.
  const row = outcome === "processed" ? await subscriptionRow(ctx, customer.mode, fact.subscriptionId) : null;
  if (row?.customerRef !== customer._id) return;
  const ended = ENDED_STATUS.get(fact.status as "failed");
  await ctx.db.patch("billingSubscriptions", row._id, {
    observedAt: now, ...(ended ? { status: ended } : {}),
    ...(!fact.cancelAtNextBillingDate ? { cancelAt: undefined } : fact.nextBillingAt !== undefined ? { cancelAt: fact.nextBillingAt } : {}),
  });
}

async function markReceipts(ctx: Ctx, customer: Customer, receipts: Doc<"billingEvents">[], outcomes: Outcome[]) {
  let processed = 0;
  for (const [index, receipt] of receipts.entries()) {
    if (outcomes[index] === "processed") {
      processed += 1;
      await ctx.db.patch("billingEvents", receipt._id, { state: "processed" });
    } else if (outcomes[index] === "quarantined") {
      // Still counted in unresolvedReceipts for support; only a negative one blocks grants.
      await ctx.db.patch("billingEvents", receipt._id, { state: "quarantined", quarantineReason: "unsupported" });
      console.error("[billingFulfill] receipt quarantined", { eventRef: receipt._id, eventType: receipt.eventType, reason: "unsupported" });
    }
  }
  if (!processed) return;
  // Re-read: an association earlier in this commit may have raised the count.
  const { unresolvedReceipts } = (await ctx.db.get("billingCustomers", customer._id))!;
  await ctx.db.patch("billingCustomers", customer._id, { unresolvedReceipts: unresolvedReceipts - processed });
}

const sortKey = ({ fact: { decision: d } }: PaymentPlan) => (d.kind === "period" ? d.serviceStart : d.kind === "top_up" ? d.settledAt : 0);

export const commitReconciliation = internalMutation({
  args: {
    customerRef: v.id("billingCustomers"),
    fence: v.object({ generation: v.number(), inputRevision: v.number() }),
    receiptRefs: v.array(v.id("billingEvents")),
    payments: v.array(paymentFactValidator),
    subscriptions: v.array(subscriptionFactValidator),
  },
  returns: v.union(v.literal("committed"), v.literal("stale"), v.literal("blocked")),
  handler: async (ctx, args) => {
    const now = Date.now();
    const customer = await ctx.db.get("billingCustomers", args.customerRef);
    if (!customer || customer.generation !== args.fence.generation || customer.inputRevision !== args.fence.inputRevision) return "stale";
    const receipts: Doc<"billingEvents">[] = [];
    for (const ref of args.receiptRefs) {
      const receipt = await ctx.db.get("billingEvents", ref);
      if (receipt?.customerRef !== customer._id || receipt.state !== "pending") return "stale";
      receipts.push(receipt);
    }
    const deleted = await ownerDeleted(ctx, customer);
    const payments: PaymentPlan[] = [];
    for (const fact of args.payments) payments.push(await planPayment(ctx, customer, fact, deleted));
    const subscriptions: SubscriptionPlan[] = [];
    for (const fact of args.subscriptions) subscriptions.push(await planSubscription(ctx, customer, fact));
    // Never depends on the positives: a negative resolves from its payment's fresh read alone.
    const reversalOutcomes = new Map(args.payments.map(fact => [fact.paymentId, reversalOutcome(fact)]));
    const resolvedNegatives = receipts.filter(r => NEGATIVE_EVENT.test(r.eventType) && r.paymentId && reversalOutcomes.get(r.paymentId) === "processed");
    const resolved = new Set(resolvedNegatives.map(r => r._id));
    // Decided before any write: skipped positives stay pending while everything else commits.
    const allowed = await positivesMayCommit(ctx, customer, payments, resolved);
    const paymentOutcomes = new Map(payments.map(p => [p.fact.paymentId, p.positive && !allowed ? "pending" as const : p.outcome]));
    const subscriptionOutcomes = new Map(subscriptions.map(plan => [plan.fact.subscriptionId, plan.outcome]));
    let granted = false;
    for (const plan of payments.sort((a, b) => sortKey(a) - sortKey(b))) {
      if (plan.outcome !== "processed" || (plan.positive && !allowed)) continue;
      if (await applyPayment(ctx, customer, plan, deleted, now)) granted = true;
    }
    // After every settlement, so a refund observed with its payment is never spendable.
    for (const plan of payments) await applyReversal(ctx, customer, plan.fact, deleted, now);
    for (const plan of subscriptions) await applySubscription(ctx, customer, plan, now);
    await markReceipts(ctx, customer, receipts, receipts.map(receipt => receiptOutcome(receipt, paymentOutcomes, subscriptionOutcomes, reversalOutcomes)));
    // A deferred payment whose negative just resolved keeps a retry of its own (the negative no longer does).
    if (!allowed) {
      const settledLater = new Set(resolvedNegatives.map(r => r.paymentId));
      for (const plan of payments) if (plan.positive && settledLater.has(plan.fact.paymentId)) await queuePaymentRead(ctx, customer._id, plan.fact.paymentId, now);
    }
    // Defence in depth: checked above, so a throw is a bug and rolls the commit back.
    if (granted) await assertGrantFence(ctx, customer._id, args.fence);
    const blocked = !allowed && payments.some(plan => plan.positive);
    if (blocked) console.warn("[billingFulfill] positives blocked", { customerRef: customer._id });
    return blocked ? "blocked" : "committed";
  },
});
