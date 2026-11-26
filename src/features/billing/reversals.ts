/**
 * Pure reversal rules for a freshly read Dodo payment (ADR 0016). Refunds and lost disputes
 * reverse the payment cumulatively and monotonically; anything ambiguous is unknown and fails
 * closed (no reversal, no grant), never a guessed debit.
 */
import type { ProviderPayment } from "./settlement";

/** Normalized SDK `RefundListItem` on `Payment.refunds`. */
export type ProviderRefund = {
  refundId: string; status: "succeeded" | "failed" | "pending" | "review" | "other";
  amountMinor: number | null; currency: string; isPartial: boolean;
};
/** Normalized SDK `Dispute` on `Payment.disputes`; the status drops its `dispute_` prefix. */
export type ProviderDispute = {
  disputeId: string;
  status: "opened" | "challenged" | "won" | "lost" | "accepted" | "cancelled" | "expired" | "other";
  amountMinor: number | null; currency: string;
};

/** Per list (refunds, disputes) on one payment; more is unknown. */
export const MAX_ADJUSTMENTS_PER_PAYMENT = 20;

/** Whether a refund/dispute status counts toward money reversed. */
export const refundCounts = (refund: ProviderRefund) => refund.status === "succeeded";
export const disputeCounts = (dispute: ProviderDispute) => dispute.status === "lost" || dispute.status === "accepted";
const RELEASED_DISPUTE_STATUSES = new Set<ProviderDispute["status"]>(["won", "cancelled", "lost", "accepted"]);
/** Opened, challenged, expired and unrecognised disputes hold the customer. */
export const disputeHolds = (dispute: Pick<ProviderDispute, "status">) => !RELEASED_DISPUTE_STATUSES.has(dispute.status);

/**
 * The counted minor amount of one entry, or null when unknown. A missing amount counts as the
 * full total only when the provider says the refund is not partial; an amount in another
 * currency (or none) is unknown.
 */
export function countedMinor(
  entry: { amountMinor: number | null; currency: string; isPartial?: boolean },
  payment: { totalMinor: number; currency: string },
): number | null {
  if (entry.amountMinor === null) return entry.isPartial === false ? payment.totalMinor : null;
  return entry.currency !== "" && entry.currency === payment.currency ? entry.amountMinor : null;
}

/** min(total, sum): refund and dispute recovery of the same money is capped at the payment. */
export const cumulativeReversedMinor = (counted: number[], totalMinor: number) =>
  Math.min(totalMinor, counted.reduce((sum, minor) => sum + minor, 0));

/** Credits to have revoked in total; a full reversal is exact, a partial one floors once over the cumulative amount. */
export function revocationTarget(credits: number, reversedMinor: number, totalMinor: number): number {
  if (totalMinor <= 0 || reversedMinor <= 0) return 0;
  return reversedMinor >= totalMinor ? credits : Math.floor((credits * reversedMinor) / totalMinor);
}

export type ReversalDecision =
  | { kind: "unknown"; reason: "missing" | "status" | "amount" | "currency" }
  | {
    kind: "known";
    refunds: (ProviderRefund & { counted: number })[];
    disputes: (ProviderDispute & { counted: number; hold: boolean })[];
  };

/**
 * Validates every entry that counts; `counted` is 0 for entries that do not count. An unrecognised
 * refund status is unknown, never a known zero: a new terminal status must not leave refunded
 * credits spendable. (An unrecognised dispute status already fails closed by holding.)
 */
export function decideReversal(
  payment: Pick<ProviderPayment, "totalMinor" | "currency" | "adjustments">,
): ReversalDecision {
  const { adjustments } = payment;
  if (!adjustments || adjustments.refunds.length > MAX_ADJUSTMENTS_PER_PAYMENT ||
    adjustments.disputes.length > MAX_ADJUSTMENTS_PER_PAYMENT) return { kind: "unknown", reason: "missing" };
  let unknown: "status" | "amount" | "currency" | undefined = adjustments.refunds.some(refund => refund.status === "other")
    ? "status" : undefined;
  const count = (counts: boolean, entry: Parameters<typeof countedMinor>[0]) => {
    if (!counts) return 0;
    const minor = countedMinor(entry, payment);
    if (minor === null) unknown ??= entry.amountMinor === null ? "amount" : "currency";
    return minor ?? 0;
  };
  const refunds = adjustments.refunds.map(refund => ({ ...refund, counted: count(refundCounts(refund), refund) }));
  const disputes = adjustments.disputes.map(dispute => ({
    ...dispute, counted: count(disputeCounts(dispute), dispute), hold: disputeHolds(dispute),
  }));
  return unknown ? { kind: "unknown", reason: unknown } : { kind: "known", refunds, disputes };
}
