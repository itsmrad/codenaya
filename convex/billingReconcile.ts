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
const PROVIDER_EVENT = /^(payment|subscription)\./;
const NEGATIVE_EVENT = /^(refund|dispute)\./;

type Receipt = Claim["receipts"][number];
/** null: the read failed permanently. */
type Reads<T> = Map<string, T | null>;

/**
 * Reads the current provider state for a claim's receipts and commits it fenced. Event
 * order and names are never trusted. A retryable read error throws, so the whole claim
 * backs off; receipts past the read budget stay pending for the next claim.
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

  const payments: Reads<ProviderPayment> = new Map();
  const subscriptions: Reads<ProviderSubscription> = new Map();
  let budget = MAX_PROVIDER_READS_PER_CLAIM;
  async function read<T>(reads: Reads<T>, id: string, fetchOne: () => Promise<T>) {
    if (reads.has(id)) return true;
    if (budget === 0) return false;
    budget -= 1;
    try {
      reads.set(id, await fetchOne());
    } catch (error) {
      if (!(error instanceof DodoReadError) || error.retryable) throw error;
      reads.set(id, null);
    }
    return true;
  }
  const readAll = async ({ eventType, paymentId, subscriptionId }: Receipt) => {
    if (!PROVIDER_EVENT.test(eventType)) return true;
    if (paymentId && !(await read(payments, paymentId, () => fetchPayment(config, paymentId)))) return false;
    for (const id of new Set([subscriptionId, paymentId && payments.get(paymentId)?.subscriptionId])) {
      if (id && !(await read(subscriptions, id, () => fetchSubscription(config, id)))) return false;
    }
    return true;
  };

  // Sequential, in claim order; refunds and disputes stay pending (stage 8).
  const covered: Receipt[] = [];
  for (const receipt of claim.receipts) {
    if (NEGATIVE_EVENT.test(receipt.eventType)) continue;
    if (!(await readAll(receipt))) break;
    covered.push(receipt);
  }
  if (!covered.length) return;

  const paymentFacts = new Map<string, PaymentFact>();
  for (const { eventType, paymentId, sessionId } of covered) {
    if (!paymentId || !PROVIDER_EVENT.test(eventType) || paymentFacts.has(paymentId)) continue;
    const payment = payments.get(paymentId);
    if (!payment) {
      paymentFacts.set(paymentId, { paymentId, decision: { kind: "unreadable", paymentId }, sessionId });
      continue;
    }
    const subscription = payment.subscriptionId ? subscriptions.get(payment.subscriptionId) ?? null : null;
    const decision = decideSettlement({ payment, subscription, customerId, catalog: config });
    const { currency, totalMinor, taxMinor } = payment;
    paymentFacts.set(paymentId, { paymentId, decision, sessionId: payment.sessionId ?? sessionId, currency: currency || undefined, totalMinor, taxMinor });
  }
  const subscriptionFacts = [...subscriptions].map(([subscriptionId, subscription]) => subscription ?? { subscriptionId, unreadable: true as const });

  const result = await ctx.runMutation(internal.billingFulfill.commitReconciliation, {
    customerRef,
    fence: { generation: claim.generation, inputRevision: claim.inputRevision },
    receiptRefs: covered.map(receipt => receipt.eventRef),
    payments: [...paymentFacts.values()],
    subscriptions: subscriptionFacts,
  });
  // stale or blocked: the release reschedules from the receipts' backoff.
  if (result !== "committed") console.warn("[billingReconcile] commit not applied", { customerRef, generation: claim.generation, result });
};
