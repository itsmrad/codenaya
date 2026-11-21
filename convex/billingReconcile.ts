import { decideReversal } from "../src/features/billing/reversals";
import { DodoReadError, fetchPayment, fetchSubscription } from "../src/features/billing/server/dodo-reads";
import { decideSettlement, type ProviderPayment, type ProviderSubscription } from "../src/features/billing/settlement";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { readConvexBillingConfig } from "./billingEnv";
import type { PaymentFact } from "./billingFulfill";
import type { Claim } from "./billingQueue";

/** 20 × the 15 s read timeout stays well inside the 10-minute action limit and the 11-minute lease. */
export const MAX_PROVIDER_READS_PER_CLAIM = 20;
// Refunds and disputes carry their payment's id and resolve from the same fresh read.
const PROVIDER_EVENT = /^(payment|subscription|refund|dispute)\./;

type Receipt = Claim["receipts"][number];
type Read = "read" | "failed" | "over_budget";

/**
 * Reads the current provider state for a claim's receipts and commits it fenced. Event
 * order and names are never trusted. A failed read (retryable or not) is never a business
 * outcome: the receipts that need it stay pending and back off, and the rest still commit.
 * Receipts past the read budget stay pending for the next claim.
 */
export const reconcileClaim = async (ctx: ActionCtx, customerRef: Id<"billingCustomers">, claim: Claim): Promise<void> => {
  const config = readConvexBillingConfig("convex-reconciler");
  if (!config) return;
  if (config.environment !== claim.mode) {
    console.error("[billingReconcile] mode mismatch", { customerRef, claimMode: claim.mode, configMode: config.environment });
    return;
  }
  const { customerId } = claim;
  if (customerId === null) return;

  const payments = new Map<string, ProviderPayment>();
  const subscriptions = new Map<string, ProviderSubscription & { readStartedAt?: number }>();
  const failed = new Set<string>();
  let budget = MAX_PROVIDER_READS_PER_CLAIM;
  async function read<T>(reads: Map<string, T>, kind: "payment" | "subscription", id: string, fetchOne: () => Promise<T>): Promise<Read> {
    if (reads.has(id)) return "read";
    if (failed.has(`${kind}:${id}`)) return "failed";
    if (budget === 0) return "over_budget";
    budget -= 1;
    try {
      reads.set(id, await fetchOne());
      return "read";
    } catch (error) {
      if (!(error instanceof DodoReadError)) throw error;
      failed.add(`${kind}:${id}`);
      // Ids and status only: a read error may reflect config, never a fact about the money.
      console.error("[billingReconcile] provider read failed", { customerRef, kind, id, status: error.status, retryable: error.retryable });
      return "failed";
    }
  }
  const readAll = async ({ eventType, paymentId, subscriptionId }: Receipt): Promise<Read> => {
    if (!PROVIDER_EVENT.test(eventType)) return "read";
    if (paymentId) {
      const result = await read(payments, "payment", paymentId, () => fetchPayment(config, paymentId));
      if (result !== "read") return result;
    }
    for (const id of new Set([subscriptionId, paymentId && payments.get(paymentId)?.subscriptionId])) {
      const result = id ? await read(subscriptions, "subscription", id, async () => {
        const readStartedAt = Date.now();
        return { ...await fetchSubscription(config, id), readStartedAt };
      }) : "read";
      if (result !== "read") return result;
    }
    return "read";
  };

  // Sequential, in claim order.
  const covered: Receipt[] = [];
  for (const receipt of claim.receipts) {
    const result = await readAll(receipt);
    if (result === "over_budget") break;
    if (result === "read") covered.push(receipt);
  }
  if (!covered.length) return;

  const paymentFacts = new Map<string, PaymentFact>();
  for (const { eventType, paymentId, sessionId } of covered) {
    const payment = paymentId && PROVIDER_EVENT.test(eventType) ? payments.get(paymentId) : undefined;
    if (!payment || paymentFacts.has(payment.paymentId)) continue;
    const subscription = payment.subscriptionId ? subscriptions.get(payment.subscriptionId) ?? null : null;
    const decision = decideSettlement({ payment, subscription, customerId, catalog: config });
    const { currency, totalMinor, taxMinor } = payment;
    paymentFacts.set(payment.paymentId, {
      paymentId: payment.paymentId, decision, sessionId: payment.sessionId ?? sessionId, currency: currency || undefined, totalMinor, taxMinor,
      reversal: decideReversal(payment),
    });
  }

  const result = await ctx.runMutation(internal.billingFulfill.commitReconciliation, {
    customerRef,
    fence: { generation: claim.generation, inputRevision: claim.inputRevision },
    receiptRefs: covered.map(receipt => receipt.eventRef),
    payments: [...paymentFacts.values()],
    subscriptions: [...subscriptions.values()],
  });
  // stale or blocked: the release reschedules from the receipts' backoff.
  if (result !== "committed") console.warn("[billingReconcile] commit not applied", { customerRef, generation: claim.generation, result });
};
