import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

describe("paid credits gate", () => {
  // Free-allocation-first and grant-side debt offset aren't built yet: until
  // they land, only the schema declares these fields and only the charge reads them.
  it("nothing outside tests enables paid credits on an account", () => {
    const mentions = ["convex", "src"].flatMap((dir) =>
      readdirSync(dir, { recursive: true, encoding: "utf8" })
        .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.includes("_generated"))
        .map((file) => join(dir, file))
        .filter((path) => /paidCredits(Version|Mode)/.test(readFileSync(path, "utf8"))),
    );
    expect(mentions.sort()).toEqual(["convex/credits.ts", "convex/schema.ts"]);
    expect(readFileSync("convex/credits.ts", "utf8")).not.toMatch(/paidCredits(Version|Mode)\s*:/);
  });
});
