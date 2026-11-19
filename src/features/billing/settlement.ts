/**
 * Pure settlement rules for a freshly read Dodo payment (ADR 0016). Decides whether a
 * payment grants a paid period, a top-up, or nothing. Anything unknown fails closed:
 * pending or quarantine, never a grant.
 */
import { PLANS, TOP_UP } from "./plans";

export const BILLING_CATALOG_VERSION = "2026-11-17";

/** Normalized `GET /payments/{id}`; field meanings follow dodopayments SDK 2.63.0. */
export type ProviderPayment = {
  paymentId: string; businessId: string; customerId: string;
  status: "succeeded" | "processing" | "failed" | "cancelled" | "other";
  subscriptionId?: string; sessionId?: string;
  cart: { productId: string; quantity: number }[];
  totalMinor: number; taxMinor?: number; currency: string; createdAt: number;
  /** SDK `charge_type`: `new`, `renewal`, `plan_change` or `on_demand`; absent for a one-time payment. */
  chargeType?: string;
  /** SDK `service_periods`; absent when the field was missing or malformed (unknown, not empty). */
  servicePeriods?: { subscriptionId: string; start: number; end: number; prorationFactor: string }[];
};

/** Normalized `GET /subscriptions/{id}`. */
export type ProviderSubscription = {
  subscriptionId: string; customerId: string; productId: string;
  status: "pending" | "active" | "on_hold" | "paused" | "cancelled" | "failed" | "expired" | "other";
  previousBillingAt?: number; nextBillingAt?: number; cancelAtNextBillingDate: boolean;
};

export type SettlementDecision =
  | { kind: "period"; paymentId: string; subscriptionId: string; productId: string; serviceStart: number; serviceEnd: number; credits: number; settledAt: number }
  | { kind: "top_up"; paymentId: string; productId: string; credits: number; settledAt: number }
  | { kind: "processing"; paymentId: string }
  | { kind: "pending"; paymentId: string; reason: "service_period_unknown" | "charge_type_unknown" }
  | { kind: "no_grant"; paymentId: string; reason: "failed" | "cancelled" | "not_full_period" }
  | { kind: "quarantine"; paymentId: string; reason: "customer_mismatch" | "cart" | "amount" | "unknown_product" | "subscription_mismatch" };

// `new` and `renewal` pay for service periods; the others never mint a monthly allowance.
const PERIOD_CHARGES = new Set(["new", "renewal"]);
const NON_PERIOD_CHARGES = new Set(["plan_change", "on_demand"]);

export function decideSettlement(input: {
  payment: ProviderPayment; subscription: ProviderSubscription | null; customerId: string;
  catalog: { proProductId: string; topUpProductId?: string };
}): SettlementDecision {
  const { payment, subscription, customerId, catalog } = input;
  const { paymentId } = payment;
  if (payment.customerId !== customerId) return { kind: "quarantine", paymentId, reason: "customer_mismatch" };
  if (payment.status === "failed" || payment.status === "cancelled") {
    return { kind: "no_grant", paymentId, reason: payment.status };
  }
  // Unknown statuses ("requires …", partial captures) stay recorded and are never granted.
  if (payment.status !== "succeeded") return { kind: "processing", paymentId };

  const [line, ...extra] = payment.cart;
  if (!line || extra.length > 0 || line.quantity !== 1) return { kind: "quarantine", paymentId, reason: "cart" };
  // A zero-priced or discounted-to-zero purchase never mints credits.
  if (!(payment.totalMinor > 0) || !payment.currency) return { kind: "quarantine", paymentId, reason: "amount" };

  // Provider time keeps the derived top-up expiry identical on replay.
  const settledAt = payment.createdAt;
  if (catalog.topUpProductId && line.productId === catalog.topUpProductId) {
    return { kind: "top_up", paymentId, productId: line.productId, credits: TOP_UP.credits, settledAt };
  }
  if (line.productId !== catalog.proProductId) return { kind: "quarantine", paymentId, reason: "unknown_product" };
  return decidePeriod(payment, subscription, line.productId, settledAt);
}

function decidePeriod(
  payment: ProviderPayment, subscription: ProviderSubscription | null, productId: string, settledAt: number,
): SettlementDecision {
  const { paymentId, subscriptionId } = payment;
  if (
    !subscriptionId || !subscription || subscription.subscriptionId !== subscriptionId ||
    subscription.customerId !== payment.customerId || subscription.productId !== productId
  ) {
    return { kind: "quarantine", paymentId, reason: "subscription_mismatch" };
  }
  const { chargeType, servicePeriods } = payment;
  if (chargeType && NON_PERIOD_CHARGES.has(chargeType)) return { kind: "no_grant", paymentId, reason: "not_full_period" };
  if (!chargeType || !PERIOD_CHARGES.has(chargeType)) return { kind: "pending", paymentId, reason: "charge_type_unknown" };
  if (!servicePeriods) return { kind: "pending", paymentId, reason: "service_period_unknown" };

  const periods = servicePeriods.filter(period => period.subscriptionId === subscriptionId);
  // SDK 2.63.0: a `renewal` with no entry for its subscription bills usage only and does not extend service.
  if (periods.length === 0 && chargeType === "renewal") return { kind: "no_grant", paymentId, reason: "not_full_period" };
  const [period] = periods;
  if (periods.length !== 1 || !(period.start < period.end)) {
    return { kind: "pending", paymentId, reason: "service_period_unknown" };
  }
  // "1" is one full billing period; a smaller factor is a prorated partial period.
  const factor = Number(period.prorationFactor);
  if (factor > 0 && factor < 1) return { kind: "no_grant", paymentId, reason: "not_full_period" };
  if (factor !== 1) return { kind: "pending", paymentId, reason: "service_period_unknown" };
  return {
    kind: "period", paymentId, subscriptionId, productId,
    serviceStart: period.start, serviceEnd: period.end, credits: PLANS.pro.monthlyCredits, settledAt,
  };
}
