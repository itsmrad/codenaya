import { describe, expect, it } from "vitest";

import {
  MAX_ADJUSTMENTS_PER_PAYMENT, countedMinor, cumulativeReversedMinor, decideReversal, disputeHolds,
  revocationTarget, type ProviderDispute, type ProviderRefund,
} from "./reversals";

const refund = (overrides: Partial<ProviderRefund> = {}): ProviderRefund => ({
  refundId: "ref_1", status: "succeeded", amountMinor: 1000, currency: "USD", isPartial: true, ...overrides,
});
const dispute = (overrides: Partial<ProviderDispute> = {}): ProviderDispute => ({
  disputeId: "dsp_1", status: "opened", amountMinor: 2000, currency: "USD", ...overrides,
});
const decide = (refunds: ProviderRefund[], disputes: ProviderDispute[] = [], totalMinor = 2000) =>
  decideReversal({ totalMinor, currency: "USD", adjustments: { refunds, disputes } });
/** reversedMinor of a known decision, as the commit computes it. */
const reversed = (decision: ReturnType<typeof decide>, totalMinor = 2000) => {
  if (decision.kind !== "known") throw new Error(`expected known, got ${decision.reason}`);
  return cumulativeReversedMinor([...decision.refunds, ...decision.disputes].map(entry => entry.counted), totalMinor);
};

describe("reversal rules", () => {
  it("floors partial refunds once over the cumulative amount, never per refund", () => {
    const first = reversed(decide([refund({ amountMinor: 333 })]));
    expect(revocationTarget(2000, first, 2000)).toBe(333);
    const both = reversed(decide([refund({ amountMinor: 333 }), refund({ refundId: "ref_2", amountMinor: 334 })]));
    expect(both).toBe(667);
    expect(revocationTarget(2000, both, 2000)).toBe(667);
    // 30% then 50%: 1,000 credits over a 1,000 total floor the cumulative fraction.
    expect(revocationTarget(1000, 300, 1000)).toBe(300);
    expect(revocationTarget(1000, 800, 1000)).toBe(800);
    expect(revocationTarget(2000, 1, 3)).toBe(666);
  });
  it("reverses a full refund exactly", () => {
    const total = reversed(decide([refund({ amountMinor: 2000, isPartial: false })]));
    expect(total).toBe(2000);
    expect(revocationTarget(1999, total, 2000)).toBe(1999);
  });
  it("caps a refund and a lost dispute of the same money at the total", () => {
    const decision = decide([refund({ amountMinor: 1500 })], [dispute({ status: "lost", amountMinor: 2000 })]);
    expect(reversed(decision)).toBe(2000);
    expect(revocationTarget(2000, reversed(decision), 2000)).toBe(2000);
  });
  it("counts a succeeded refund without an amount as full only when it is not partial", () => {
    expect(reversed(decide([refund({ amountMinor: null, currency: "", isPartial: false })]))).toBe(2000);
    expect(decide([refund({ amountMinor: null, isPartial: true })])).toEqual({ kind: "unknown", reason: "amount" });
  });
  it("treats a counted amount in another currency, or none, as unknown", () => {
    expect(decide([refund({ currency: "EUR" })])).toEqual({ kind: "unknown", reason: "currency" });
    expect(decide([refund({ currency: "" })])).toEqual({ kind: "unknown", reason: "currency" });
    expect(decide([], [dispute({ status: "lost", currency: "INR" })])).toEqual({ kind: "unknown", reason: "currency" });
    expect(decide([], [dispute({ status: "accepted", amountMinor: null })])).toEqual({ kind: "unknown", reason: "amount" });
    // An empty payment currency never matches an empty entry currency.
    expect(countedMinor({ amountMinor: 5, currency: "" }, { totalMinor: 10, currency: "" })).toBeNull();
  });
  it.each(["failed", "pending", "review", "other"] as const)("never counts a %s refund", (status) => {
    // Not counted, so its odd amount or currency is never validated.
    const decision = decide([refund({ status, amountMinor: null, currency: "EUR" })]);
    expect(decision).toMatchObject({ kind: "known", refunds: [{ refundId: "ref_1", counted: 0 }] });
    expect(reversed(decision)).toBe(0);
  });
  it.each([
    ["opened", true, 0], ["challenged", true, 0], ["expired", true, 0], ["other", true, 0],
    ["won", false, 0], ["cancelled", false, 0], ["lost", false, 2000], ["accepted", false, 2000],
  ] as const)("a %s dispute holds=%s and counts %s", (status, hold, counted) => {
    expect(disputeHolds(dispute({ status }))).toBe(hold);
    expect(decide([], [dispute({ status })])).toEqual({
      kind: "known", refunds: [], disputes: [{ ...dispute({ status }), counted, hold }],
    });
  });
  it("holds per dispute: one won dispute leaves another open one holding", () => {
    const decision = decide([], [dispute({ status: "won" }), dispute({ disputeId: "dsp_2", status: "challenged" })]);
    expect(decision).toMatchObject({ kind: "known", disputes: [{ hold: false }, { disputeId: "dsp_2", hold: true }] });
  });
  it("treats missing or oversize lists as unknown, never empty", () => {
    expect(decideReversal({ totalMinor: 2000, currency: "USD" })).toEqual({ kind: "unknown", reason: "missing" });
    const many = Array.from({ length: MAX_ADJUSTMENTS_PER_PAYMENT + 1 }, (_, i) => refund({ refundId: `ref_${i}`, status: "failed" }));
    expect(decide(many)).toEqual({ kind: "unknown", reason: "missing" });
    expect(decide([])).toEqual({ kind: "known", refunds: [], disputes: [] });
  });
  it("never divides by a zero total", () => {
    expect(revocationTarget(1000, 0, 0)).toBe(0);
    expect(revocationTarget(1000, 500, 0)).toBe(0);
    expect(revocationTarget(1000, 0, 2000)).toBe(0);
    expect(reversed(decide([refund({ amountMinor: null, isPartial: false })], [], 0), 0)).toBe(0);
  });
});
