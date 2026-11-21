import { v, type Infer } from "convex/values";

import { lotUnspent } from "../src/features/billing/grants";
import { cumulativeReversedMinor, MAX_ADJUSTMENTS_PER_PAYMENT, revocationTarget } from "../src/features/billing/reversals";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { addReversalDebt, exhaustedIf } from "./billingGrants";

/**
 * Commits refunds and disputes read fresh off a payment (ADR 0016, docs/billing-stage8.md).
 * Plain helpers called by fulfillment, so a reversal commits in the same transaction as the
 * grant it takes back. Cumulative and monotone: counted amounts and revoked credits only grow,
 * so a replayed or repeated finding (webhook or poll) never applies twice.
 */

/** A period lot plus its one rollover; a top-up has one lot. */
export const MAX_LOTS_PER_PURCHASE = 2;
/** Refund and dispute rows of one payment: both provider lists at their cap. */
const MAX_ROWS_PER_PAYMENT = 2 * MAX_ADJUSTMENTS_PER_PAYMENT;

const amountValidator = v.union(v.number(), v.null());
/** `ReversalDecision` from `src/features/billing/reversals.ts`, as the reconciler sends it. */
export const reversalDecisionValidator = v.union(
  v.object({ kind: v.literal("unknown"), reason: v.union(v.literal("missing"), v.literal("status"), v.literal("amount"), v.literal("currency")) }),
  v.object({
    kind: v.literal("known"),
    refunds: v.array(v.object({
      refundId: v.string(), status: v.string(), amountMinor: amountValidator, currency: v.string(), isPartial: v.boolean(), counted: v.number(),
    })),
    disputes: v.array(v.object({
      disputeId: v.string(), status: v.string(), amountMinor: amountValidator, currency: v.string(), counted: v.number(), hold: v.boolean(),
    })),
  }),
);
type KnownReversal = Extract<Infer<typeof reversalDecisionValidator>, { kind: "known" }>;
type Customer = Doc<"billingCustomers">;

/** Whether any dispute (or support) hold of this customer is active: it refuses checkouts, never grants. */
export const hasActiveHold = async (ctx: QueryCtx, customerRef: Id<"billingCustomers">) =>
  (await ctx.db.query("billingAdjustments")
    .withIndex("by_customerRef_and_holdActive", q => q.eq("customerRef", customerRef).eq("holdActive", true)).first()) !== null;

/** Upserts this payment's adjustment rows from a known decision; returns its monotone reversed amount. */
export async function recordAdjustments(
  ctx: MutationCtx, customer: Customer, paymentId: string, decision: KnownReversal, totalMinor: number,
  purchaseRef: Id<"billingPurchases"> | undefined, now: number,
) {
  const entries = [
    ...decision.refunds.map(r => ({ kind: "refund" as const, providerId: r.refundId, status: r.status, counted: r.counted, currency: r.currency, hold: false })),
    ...decision.disputes.map(d => ({ kind: "dispute" as const, providerId: d.disputeId, ...d })),
  ];
  for (const { kind, providerId, status, counted, currency, hold } of entries) {
    const row = await ctx.db.query("billingAdjustments")
      .withIndex("by_mode_and_providerId", q => q.eq("mode", customer.mode).eq("providerId", providerId)).unique();
    if (!row) {
      await ctx.db.insert("billingAdjustments", {
        mode: customer.mode, customerRef: customer._id, paymentId, ...(purchaseRef ? { purchaseRef } : {}), kind, providerId, status,
        countedMinor: counted, ...(currency ? { currency } : {}), holdActive: hold, observedAt: now,
      });
      continue;
    }
    if (row.customerRef !== customer._id || row.paymentId !== paymentId || row.kind !== kind) {
      console.error("[billingReversals] adjustment bound elsewhere", { customerRef: customer._id, paymentId, providerId });
      continue;
    }
    if (row.countedMinor > counted) {
      console.error("[billingReversals] counted adjustment no longer counts", { paymentId, providerId, status });
    }
    const countedMinor = Math.max(row.countedMinor, counted);
    if (row.status === status && row.countedMinor === countedMinor && row.holdActive === hold && (row.purchaseRef || !purchaseRef)) continue;
    await ctx.db.patch("billingAdjustments", row._id, { status, countedMinor, holdActive: hold, observedAt: now, ...(purchaseRef ? { purchaseRef } : {}) });
  }
  const rows = await ctx.db.query("billingAdjustments")
    .withIndex("by_mode_and_paymentId", q => q.eq("mode", customer.mode).eq("paymentId", paymentId)).take(MAX_ROWS_PER_PAYMENT + 1);
  if (rows.length > MAX_ROWS_PER_PAYMENT) throw new Error("billingAdjustments over the per-payment bound");
  return cumulativeReversedMinor(rows.filter(row => row.kind !== "support_hold").map(row => row.countedMinor), totalMinor);
}

/**
 * Revokes up to the cumulative target from an owned purchase's lots, its rollover first (it holds
 * what the period lot carried over), expired lots included; what was already spent becomes debt.
 * Idempotent through `revokedCredits`: only the difference to the target is ever revoked.
 */
export async function applyPurchaseReversal(
  ctx: MutationCtx, customer: Customer, purchase: Doc<"billingPurchases">, reversed: number, totalMinor: number, deleted: boolean,
) {
  if (purchase.customerRef !== customer._id) throw new Error("Reversal of another customer's purchase");
  const reversedMinor = Math.max(purchase.reversedMinor ?? 0, reversed);
  const revoked = purchase.revokedCredits ?? 0;
  const target = purchase.state === "settled" ? revocationTarget(purchase.terms.credits, reversedMinor, totalMinor) : revoked;
  if (target < revoked) console.error("[billingReversals] revocation target below revoked", { purchaseRef: purchase._id, target, revoked });
  if (reversedMinor === (purchase.reversedMinor ?? 0) && target <= revoked) return;
  // Not settled: nothing was granted yet, so only the amount is kept until settlement.
  const fields = { reversedMinor, totalMinor };
  if (target <= revoked) return await ctx.db.patch("billingPurchases", purchase._id, fields);
  const lots = await ctx.db.query("billingGrants").withIndex("by_purchaseRef", q => q.eq("purchaseRef", purchase._id)).take(MAX_LOTS_PER_PURCHASE + 1);
  if (lots.length > MAX_LOTS_PER_PURCHASE) throw new Error("billingGrants over the per-purchase bound");
  lots.sort((a, b) => Number(b.kind === "rollover") - Number(a.kind === "rollover"));
  const full = target >= purchase.terms.credits;
  let left = target - revoked;
  for (const lot of lots) {
    const take = Math.min(left, lotUnspent(lot));
    left -= take;
    const next = { ...lot, revoked: lot.revoked + take };
    if (take > 0 || full) {
      await ctx.db.patch("billingGrants", lot._id, { revoked: next.revoked, ...exhaustedIf(next), ...(full ? { fullyReversed: true as const } : {}) });
    }
  }
  if (left > 0 && (deleted || !(await addReversalDebt(ctx, customer.userId, customer.mode, left)))) {
    console.error("[billingReversals] reversal debt not recorded", { purchaseRef: purchase._id, credits: left, deleted });
  }
  await ctx.db.patch("billingPurchases", purchase._id, { ...fields, revokedCredits: target });
  console.warn("[billingReversals] credits revoked", { purchaseRef: purchase._id, target, debt: left, reversedMinor, totalMinor });
}
