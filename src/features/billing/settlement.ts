/**
 * Pure settlement rules for a freshly read Dodo payment (ADR 0016). Decides whether a
 * payment grants a paid period, a top-up, or nothing. Anything unknown fails closed:
 * pending or quarantine, never a grant.
 */
import { PLANS, TOP_UP } from "./plans";
import type { ProviderDispute, ProviderRefund } from "./reversals";

export const BILLING_CATALOG_VERSION = "2026-11-17";

/** Normalized `GET /payments/{id}`; field meanings follow dodopayments SDK 2.63.0. */
export type ProviderPayment = {
  paymentId: string; businessId: string; customerId: string;
  status: "succeeded" | "processing" | "failed" | "cancelled" | "other";
  subscriptionId?: string; sessionId?: string; purchaseIdHint?: string;
  /** SDK `product_cart`: the one-time products only; empty for a pure subscription charge. */
  cart: { productId: string; quantity: number }[];
  totalMinor: number; taxMinor?: number; currency: string; createdAt: number;
  /** SDK `charge_type`: `new`, `renewal`, `plan_change` or `on_demand`; absent for a one-time payment, `other` if unparseable. */
  chargeType?: string;
  /** SDK `service_periods`; absent when the field was missing or malformed (unknown, not empty). */
  servicePeriods?: { subscriptionId: string; start: number; end: number; prorationFactor: string }[];
  /** SDK `includes_usage`: the charge also bills metered usage. */
  includesUsage?: boolean;
  /** SDK `is_update_payment_method`: the payment only updates a subscription's card. */
  isUpdatePaymentMethod?: boolean;
  /** SDK `discount_id` (or the first of `discounts`): any discount on the payment. */
  discountId?: string;
  /** Absent when the provider sent no list or a malformed one (unknown, never empty). */
  adjustments?: { refunds: ProviderRefund[]; disputes: ProviderDispute[] };
};

/** Normalized `GET /subscriptions/{id}`. */
export type ProviderSubscription = {
  subscriptionId: string; customerId: string; productId: string; quantity?: number;
  status: "pending" | "active" | "on_hold" | "paused" | "cancelled" | "failed" | "expired" | "other";
  previousBillingAt?: number; nextBillingAt?: number; cancelAtNextBillingDate: boolean;
};

export type SettlementDecision =
  | { kind: "period"; paymentId: string; subscriptionId: string; productId: string; serviceStart: number; serviceEnd: number; credits: number; settledAt: number }
  | { kind: "top_up"; paymentId: string; productId: string; credits: number; settledAt: number }
  | { kind: "processing"; paymentId: string }
  | { kind: "pending"; paymentId: string; reason: "service_period_unknown" | "charge_type_unknown" }
  | { kind: "no_grant"; paymentId: string; reason: "failed" | "cancelled" | "not_full_period" | "payment_method_update" }
  | { kind: "quarantine"; paymentId: string; reason: "customer_mismatch" | "cart" | "amount" | "unknown_product" | "subscription_mismatch" | "discount" };

type Catalog = { proProductId: string; topUpProductId?: string };

// `new` and `renewal` pay for service periods; the others never mint a monthly allowance.
const PERIOD_CHARGES = new Set(["new", "renewal"]);
const NON_PERIOD_CHARGES = new Set(["plan_change", "on_demand"]);

export function decideSettlement(input: {
  payment: ProviderPayment; subscription: ProviderSubscription | null; customerId: string; catalog: Catalog;
}): SettlementDecision {
  const { payment, subscription, customerId, catalog } = input;
  const { paymentId } = payment;
  if (payment.customerId !== customerId) return { kind: "quarantine", paymentId, reason: "customer_mismatch" };
  // A card update is never a purchase, whatever it charged; final so it never blocks the customer.
  if (payment.isUpdatePaymentMethod === true) return { kind: "no_grant", paymentId, reason: "payment_method_update" };
  if (payment.status === "failed" || payment.status === "cancelled") {
    return { kind: "no_grant", paymentId, reason: payment.status };
  }
  // Unknown statuses ("requires …", partial captures) stay recorded and are never granted.
  if (payment.status !== "succeeded") return { kind: "processing", paymentId };
  // An unrecognised charge type is unknown, not absent: never let it reach the one-time top-up path.
  const { chargeType } = payment;
  if (chargeType !== undefined && !PERIOD_CHARGES.has(chargeType) && !NON_PERIOD_CHARGES.has(chargeType)) {
    return { kind: "pending", paymentId, reason: "charge_type_unknown" };
  }
  // Anything that names a subscription takes the period path, so it can never mint a top-up.
  return chargeType === undefined && payment.subscriptionId === undefined
    ? decideOneTime(payment, catalog)
    : decidePeriod(payment, subscription, catalog);
}

// A zero-priced or discounted-to-zero purchase never mints credits.
const hasAmount = (payment: ProviderPayment) => payment.totalMinor > 0 && payment.currency !== "";
// Defence in depth (checkout disables discount codes): totals include tax, so an undiscounted USD
// payment is never below the list price. Other currencies rely on the discount id alone.
const discounted = (payment: ProviderPayment, listPriceUsd: number) =>
  payment.discountId !== undefined || (payment.currency === "USD" && payment.totalMinor < listPriceUsd * 100);

function decideOneTime(payment: ProviderPayment, catalog: Catalog): SettlementDecision {
  const { paymentId } = payment;
  const [line, ...extra] = payment.cart;
  if (!line || extra.length > 0 || line.quantity !== 1) return { kind: "quarantine", paymentId, reason: "cart" };
  if (!hasAmount(payment)) return { kind: "quarantine", paymentId, reason: "amount" };
  if (!catalog.topUpProductId || line.productId !== catalog.topUpProductId) {
    return { kind: "quarantine", paymentId, reason: "unknown_product" };
  }
  if (discounted(payment, TOP_UP.priceUsd)) return { kind: "quarantine", paymentId, reason: "discount" };
  // Provider time keeps the derived top-up expiry identical on replay.
  return { kind: "top_up", paymentId, productId: line.productId, credits: TOP_UP.credits, settledAt: payment.createdAt };
}

/** The product comes from the verified subscription read: a subscription charge's cart lists one-time products only. */
function decidePeriod(
  payment: ProviderPayment, subscription: ProviderSubscription | null, catalog: Catalog,
): SettlementDecision {
  const { paymentId, subscriptionId, cart } = payment;
  const cartOk = cart.length === 0 ||
    (cart.length === 1 && cart[0].productId === catalog.proProductId && cart[0].quantity === 1);
  if (!cartOk) return { kind: "quarantine", paymentId, reason: "cart" };
  if (!hasAmount(payment)) return { kind: "quarantine", paymentId, reason: "amount" };
  if (
    !subscriptionId || !subscription || subscription.subscriptionId !== subscriptionId ||
    subscription.customerId !== payment.customerId
  ) {
    return { kind: "quarantine", paymentId, reason: "subscription_mismatch" };
  }
  if (subscription.productId !== catalog.proProductId) return { kind: "quarantine", paymentId, reason: "unknown_product" };
  if (subscription.quantity !== 1) return { kind: "quarantine", paymentId, reason: "cart" };
  return decideServicePeriod(payment, subscriptionId, subscription.productId);
}

function decideServicePeriod(payment: ProviderPayment, subscriptionId: string, productId: string): SettlementDecision {
  const { paymentId, chargeType, servicePeriods } = payment;
  if (chargeType && NON_PERIOD_CHARGES.has(chargeType)) return { kind: "no_grant", paymentId, reason: "not_full_period" };
  if (!chargeType || !PERIOD_CHARGES.has(chargeType)) return { kind: "pending", paymentId, reason: "charge_type_unknown" };
  if (!servicePeriods) return { kind: "pending", paymentId, reason: "service_period_unknown" };

  const periods = servicePeriods.filter(period => period.subscriptionId === subscriptionId);
  // SDK 2.63.0: a usage settlement is a `renewal` with `includes_usage` and no entry for its subscription.
  if (periods.length === 0 && chargeType === "renewal" && payment.includesUsage === true) {
    return { kind: "no_grant", paymentId, reason: "not_full_period" };
  }
  const [period] = periods;
  if (periods.length !== 1 || !(period.start < period.end)) {
    return { kind: "pending", paymentId, reason: "service_period_unknown" };
  }
  // "1" is one full billing period; a smaller factor is a prorated partial period.
  const factor = Number(period.prorationFactor);
  if (factor > 0 && factor < 1) return { kind: "no_grant", paymentId, reason: "not_full_period" };
  if (factor !== 1) return { kind: "pending", paymentId, reason: "service_period_unknown" };
  if (discounted(payment, PLANS.pro.priceUsdPerMonth)) return { kind: "quarantine", paymentId, reason: "discount" };
  return {
    kind: "period", paymentId, subscriptionId, productId,
    serviceStart: period.start, serviceEnd: period.end, credits: PLANS.pro.monthlyCredits, settledAt: payment.createdAt,
  };
}
