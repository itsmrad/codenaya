import { describe, expect, it } from "vitest";

import { type AvailabilityInput, accountAvailability, entitlement, type PeriodLot } from "./entitlement";
import type { GrantLot } from "./grants";

const DAY = 24 * 60 * 60 * 1000;
const NOV = Date.UTC(2026, 10, 1);
const OCT = Date.UTC(2026, 9, 1);
const NOW = Date.UTC(2026, 10, 19, 10);
const TODAY = Date.UTC(2026, 10, 19);

const period = (start: number, end: number, extra: Partial<PeriodLot> = {}): PeriodLot => ({
  _id: `p${start}`, kind: "current_period", quantity: 2000, consumed: 0, revoked: 0,
  expiresAt: end, serviceStart: start, serviceEnd: end, ...extra,
});
const lot = (kind: GrantLot["kind"], quantity: number, extra: Partial<GrantLot> = {}): GrantLot => ({
  _id: `${kind}${quantity}`, kind, quantity, consumed: 0, revoked: 0, expiresAt: NOW + 30 * DAY, ...extra,
});
const LIVE = period(NOW - 10 * DAY, NOW + 20 * DAY);

/** An enabled account whose Free month was stamped `freeMonthStartsAt` with `freeUsed`. */
const input = (fields: Partial<AvailabilityInput> & { freeMonthStartsAt?: number; freeUsed?: number; dayUsed?: number } = {}) => {
  const { freeMonthStartsAt = NOV, freeUsed = 0, dayUsed = 0, ...rest } = fields;
  return {
    account: { periodStartsAt: NOV, periodUsed: 0, dayStartsAt: TODAY, dayUsed, freeMonthStartsAt, freeUsed, freeDebtOffset: 0 },
    enabled: true, periodLots: [], activeLots: [], debt: 0, deleted: false, held: false, ...rest,
  };
};

describe("entitlement", () => {
  const base = { enabled: true, deleted: false, held: false };

  it("is Pro from a period's exact start until its exact end", () => {
    expect(entitlement({ ...base, periodLots: [period(NOW, NOW + DAY)] }, NOW).plan).toBe("pro");
    expect(entitlement({ ...base, periodLots: [period(NOW - DAY, NOW)] }, NOW).plan).toBe("free");
    expect(entitlement({ ...base, periodLots: [period(NOW + 1, NOW + DAY)] }, NOW)).toEqual({
      plan: "free", paidThroughMs: null, platformAllowed: true, reason: null,
    });
  });

  it("extends paid-through across adjacent early renewals, never across a gap", () => {
    const next = period(LIVE.expiresAt, LIVE.expiresAt + 30 * DAY);
    expect(entitlement({ ...base, periodLots: [next, LIVE] }, NOW).paidThroughMs).toBe(next.expiresAt);
    const later = period(LIVE.expiresAt + DAY, LIVE.expiresAt + 31 * DAY);
    expect(entitlement({ ...base, periodLots: [LIVE, later] }, NOW).paidThroughMs).toBe(LIVE.expiresAt);
  });

  it("keeps a spent or partly reversed period Pro; a fully reversed one is Free", () => {
    expect(entitlement({ ...base, periodLots: [{ ...LIVE, consumed: 2000 }] }, NOW).plan).toBe("pro");
    expect(entitlement({ ...base, periodLots: [{ ...LIVE, revoked: 500 }] }, NOW).plan).toBe("pro");
    expect(entitlement({ ...base, periodLots: [{ ...LIVE, consumed: 800, revoked: 800, fullyReversed: true }] }, NOW).plan).toBe("free");
  });

  it("never grants Pro to an account that is not billing-enabled here", () => {
    expect(entitlement({ ...base, enabled: false, periodLots: [LIVE] }, NOW).plan).toBe("free");
  });

  it("a hold keeps the paid label but stops platform use; deletion stops everything", () => {
    expect(entitlement({ ...base, held: true, periodLots: [LIVE] }, NOW)).toEqual({
      plan: "pro", paidThroughMs: LIVE.expiresAt, platformAllowed: false, reason: "on_hold",
    });
    expect(entitlement({ ...base, deleted: true, held: true, periodLots: [LIVE] }, NOW)).toEqual({
      plan: "free", paidThroughMs: null, platformAllowed: false, reason: "deleted",
    });
  });
});

describe("accountAvailability", () => {
  it("a user with no account is Free and allowed, within today's cap", () => {
    expect(accountAvailability({ ...input({ enabled: false }), account: null }, NOW)).toEqual({
      plan: "free", paidThroughMs: null, platformAllowed: true, reason: null, billingEnabled: false,
      creditsLeft: 60, paidCreditsRemaining: 0, freeRemaining: 300, debt: 0, dayLeft: 60,
      dayResetsAt: TODAY + DAY, monthResetsAt: Date.UTC(2026, 11, 1), nextChangeAt: null,
    });
  });

  it("a legacy account keeps the Free monthly grant and ignores lots", () => {
    const view = accountAvailability(input({ enabled: false, periodLots: [LIVE], activeLots: [lot("top_up", 500)] }), NOW);
    expect(view).toMatchObject({ plan: "free", creditsLeft: 60, paidCreditsRemaining: 0, freeRemaining: 300, debt: 0 });
  });

  it("a new Free month pays debt first: 500 debt leaves 200 and nothing to spend", () => {
    const view = accountAvailability(input({ freeMonthStartsAt: OCT, freeUsed: 300, debt: 500 }), NOW);
    expect(view).toMatchObject({ plan: "free", freeRemaining: 0, debt: 200, creditsLeft: 0 });
  });

  it("40 debt in a new month leaves 260 Free and no debt", () => {
    const view = accountAvailability(input({ freeMonthStartsAt: OCT, freeUsed: 300, debt: 40 }), NOW);
    expect(view).toMatchObject({ freeRemaining: 260, debt: 0, creditsLeft: 60 });
  });

  it("retained top-ups stay spendable on Free, within today's cap", () => {
    const view = accountAvailability(input({ freeUsed: 300, dayUsed: 20, activeLots: [lot("top_up", 500)] }), NOW);
    expect(view).toMatchObject({ plan: "free", freeRemaining: 0, paidCreditsRemaining: 500, creditsLeft: 40, dayLeft: 40 });
  });

  it("Pro spends lots minus debt with no calendar or daily ceiling, and leaves Free untouched", () => {
    const lots = [lot("current_period", 2000, { expiresAt: LIVE.expiresAt }), lot("rollover", 1500, { expiresAt: LIVE.expiresAt })];
    const view = accountAvailability(
      input({ freeMonthStartsAt: OCT, freeUsed: 300, dayUsed: 900, debt: 100, periodLots: [LIVE], activeLots: lots }),
      NOW,
    );
    expect(view).toMatchObject({
      plan: "pro", paidThroughMs: LIVE.expiresAt, creditsLeft: 3400, paidCreditsRemaining: 3500,
      freeRemaining: null, debt: 100, dayLeft: null, nextChangeAt: LIVE.expiresAt,
    });
  });

  it("a cancelled period returns to the same month's Free usage, not legacy Pro usage", () => {
    // Enablement stamped November at 120 used; the Pro period later ran up 1,000 on the legacy counters.
    const ended = period(NOW - 20 * DAY, NOW - DAY);
    const view = accountAvailability({ ...input({ freeUsed: 120, periodLots: [ended] }), account: {
      periodStartsAt: NOV, periodUsed: 1120, dayStartsAt: TODAY, dayUsed: 0, freeMonthStartsAt: NOV, freeUsed: 120, freeDebtOffset: 0,
    } }, NOW);
    expect(view).toMatchObject({ plan: "free", freeRemaining: 180, creditsLeft: 60 });
  });

  it("a hold or deletion leaves nothing spendable", () => {
    const pro = input({ periodLots: [LIVE], activeLots: [lot("current_period", 2000)] });
    expect(accountAvailability({ ...pro, held: true }, NOW)).toMatchObject({
      plan: "pro", platformAllowed: false, reason: "on_hold", creditsLeft: 0, paidCreditsRemaining: 2000,
    });
    expect(accountAvailability({ ...pro, deleted: true }, NOW)).toMatchObject({
      plan: "free", platformAllowed: false, reason: "deleted", creditsLeft: 0, nextChangeAt: null,
    });
  });

  it("next change is the earliest future period start, period end or lot expiry", () => {
    const future = period(NOW + 2 * DAY, NOW + 32 * DAY);
    expect(accountAvailability(input({ periodLots: [future] }), NOW)).toMatchObject({ plan: "free", nextChangeAt: future.serviceStart });
    const topUp = lot("top_up", 100, { expiresAt: NOW + DAY });
    expect(accountAvailability(input({ periodLots: [LIVE], activeLots: [topUp] }), NOW).nextChangeAt).toBe(NOW + DAY);
  });
});
