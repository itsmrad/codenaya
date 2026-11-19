import { describe, expect, it } from "vitest";

import { currentFreeAllocation, freeRemaining, paidAccountAvailability } from "./free-allocation";

const NOV = Date.UTC(2026, 10, 1);
const NOW = Date.UTC(2026, 10, 19, 10);

describe("currentFreeAllocation", () => {
  it("keeps a stored month as it is, with no second offset", () => {
    const stored = { freeMonthStartsAt: NOV, freeUsed: 40, freeDebtOffset: 100 };
    expect(currentFreeAllocation(stored, 50, NOW)).toEqual({
      allocation: { monthStartsAt: NOV, used: 40, debtOffset: 100 },
      debt: 50,
    });
  });

  it("starts a new month at used 0 and offsets debt up to the allocation", () => {
    const stored = { freeMonthStartsAt: Date.UTC(2026, 9, 1), freeUsed: 300, freeDebtOffset: 0 };
    expect(currentFreeAllocation(stored, 120, NOW)).toEqual({ allocation: { monthStartsAt: NOV, used: 0, debtOffset: 120 }, debt: 0 });
    expect(currentFreeAllocation(null, 0, NOW)).toEqual({ allocation: { monthStartsAt: NOV, used: 0, debtOffset: 0 }, debt: 0 });
  });

  it("the first allocation since enablement starts from this month's legacy usage", () => {
    const legacy = (periodUsed: number, periodStartsAt = NOV) => ({ periodStartsAt, periodUsed });
    expect(freeRemaining(currentFreeAllocation(legacy(300), 0, NOW).allocation)).toBe(0);
    expect(freeRemaining(currentFreeAllocation(legacy(450), 0, NOW).allocation)).toBe(0);
    expect(currentFreeAllocation(legacy(120), 0, NOW).allocation).toEqual({ monthStartsAt: NOV, used: 120, debtOffset: 0 });
    expect(currentFreeAllocation(legacy(120), 500, NOW)).toEqual({ allocation: { monthStartsAt: NOV, used: 120, debtOffset: 180 }, debt: 320 });
    // Last month's legacy usage, or a later month with stored Free state, starts fresh.
    expect(currentFreeAllocation(legacy(300, Date.UTC(2026, 9, 1)), 0, NOW).allocation.used).toBe(0);
    expect(currentFreeAllocation({ ...legacy(300), freeMonthStartsAt: Date.UTC(2026, 9, 1) }, 0, NOW).allocation.used).toBe(0);
  });

  it("500 debt leaves 200 debt and no Free credits", () => {
    const { allocation, debt } = currentFreeAllocation(null, 500, NOW);
    expect(debt).toBe(200);
    expect(freeRemaining(allocation)).toBe(0);
  });
});

describe("paidAccountAvailability", () => {
  const free = { inPaidPeriod: false, freeRemaining: 0, lotsRemaining: 0, debt: 0, dayUsed: 0 };

  it("on Free, an exhausted allocation plus a top-up is limited by the daily cap only", () => {
    expect(paidAccountAvailability({ ...free, lotsRemaining: 500, dayUsed: 0 })).toBe(60);
    expect(paidAccountAvailability({ ...free, lotsRemaining: 500, dayUsed: 45 })).toBe(15);
    expect(paidAccountAvailability({ ...free, lotsRemaining: 20, freeRemaining: 10 })).toBe(30);
  });

  it("on Free, subtracts debt and never goes negative", () => {
    expect(paidAccountAvailability({ ...free, freeRemaining: 100, lotsRemaining: 0, debt: 70 })).toBe(30);
    expect(paidAccountAvailability({ ...free, lotsRemaining: 10, debt: 70 })).toBe(0);
    expect(paidAccountAvailability({ ...free, lotsRemaining: 500, dayUsed: 90 })).toBe(0);
  });

  it("in a paid period, has no daily cap and subtracts debt", () => {
    const paid = { ...free, inPaidPeriod: true, freeRemaining: 300 };
    expect(paidAccountAvailability({ ...paid, lotsRemaining: 2500, debt: 100, dayUsed: 1000 })).toBe(2400);
    expect(paidAccountAvailability({ ...paid, lotsRemaining: 10, debt: 100 })).toBe(0);
  });
});
