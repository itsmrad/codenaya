import { describe, expect, it } from "vitest";

import { allocateCredits, type GrantLot, lotRemaining } from "./grants";

const NOW = 1_000;
const lot = (_id: string, kind: GrantLot["kind"], quantity: number, extra: Partial<GrantLot> = {}): GrantLot => ({
  _id,
  kind,
  quantity,
  consumed: 0,
  revoked: 0,
  expiresAt: NOW + 100,
  ...extra,
});
const spent = (lots: GrantLot[], credits: number) => {
  const { takes, shortfall } = allocateCredits(lots, credits, NOW);
  return { takes: takes.map((take) => [take.lot._id, take.credits]), shortfall };
};

describe("allocateCredits", () => {
  it("spends current period, then rollover, then the earliest-expiring top-up", () => {
    const lots = [
      lot("t_late", "top_up", 5, { expiresAt: NOW + 300 }),
      lot("t_early", "top_up", 5, { expiresAt: NOW + 200 }),
      lot("roll", "rollover", 5),
      lot("cur", "current_period", 5, { expiresAt: NOW + 500 }),
    ];
    expect(spent(lots, 18)).toEqual({
      takes: [["cur", 5], ["roll", 5], ["t_early", 5], ["t_late", 3]],
      shortfall: 0,
    });
  });

  it("breaks equal expiries by id", () => {
    expect(spent([lot("b", "top_up", 5), lot("a", "top_up", 5)], 7).takes).toEqual([["a", 5], ["b", 2]]);
  });

  it("splits a charge across a partly spent lot", () => {
    expect(spent([lot("cur", "current_period", 10, { consumed: 8 }), lot("t", "top_up", 10)], 5)).toEqual({
      takes: [["cur", 2], ["t", 3]],
      shortfall: 0,
    });
  });

  it("skips expired, revoked and spent lots", () => {
    const lots = [
      lot("expired", "current_period", 10, { expiresAt: NOW }),
      lot("revoked", "rollover", 10, { revoked: 10 }),
      lot("spent", "top_up", 10, { consumed: 10 }),
      lot("half", "top_up", 10, { revoked: 4, consumed: 2, expiresAt: NOW + 200 }),
    ];
    expect(spent(lots, 3).takes).toEqual([["half", 3]]);
    expect(lotRemaining(lots[0], NOW - 1)).toBe(10);
  });

  it("returns what the lots can't cover as the shortfall", () => {
    expect(spent([lot("cur", "current_period", 4)], 10)).toEqual({ takes: [["cur", 4]], shortfall: 6 });
    expect(spent([], 10)).toEqual({ takes: [], shortfall: 10 });
  });
});
