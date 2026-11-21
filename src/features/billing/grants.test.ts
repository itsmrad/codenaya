import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  allocateCredits,
  type GrantLot,
  isInPaidPeriod,
  lotRemaining,
  lotUnspent,
  ROLLOVER_CAP,
  rolloverQuantity,
  topUpExpiresAt,
} from "./grants";

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

  it("never spends a next period's lot before its serviceStart, and spends it first once it starts", () => {
    const lots = [
      lot("next", "current_period", 50, { serviceStart: NOW + 100, expiresAt: NOW + 400 }),
      lot("t", "top_up", 5, { expiresAt: NOW + 500 }),
      lot("roll", "rollover", 5, { expiresAt: NOW + 400 }),
      lot("cur", "current_period", 5, { serviceStart: NOW - 100, expiresAt: NOW + 100 }),
    ];
    expect(spent(lots, 20)).toEqual({ takes: [["cur", 5], ["roll", 5], ["t", 5]], shortfall: 5 });
    expect(lotRemaining(lots[0], NOW + 99)).toBe(0);
    expect(lotRemaining(lots[0], NOW + 100)).toBe(50);
    const atStart = allocateCredits(lots, 20, NOW + 100).takes.map((take) => [take.lot._id, take.credits]);
    expect(atStart).toEqual([["next", 20]]);
  });

  it("returns what the lots can't cover as the shortfall", () => {
    expect(spent([lot("cur", "current_period", 4)], 10)).toEqual({ takes: [["cur", 4]], shortfall: 6 });
    expect(spent([], 10)).toEqual({ takes: [], shortfall: 10 });
  });
});

describe("lot balances", () => {
  it("subtracts transfers and debt offsets, and nothing remains once expired", () => {
    const half = lot("t", "top_up", 100, { consumed: 10, revoked: 5, transferred: 20, debtOffset: 30 });
    expect(lotUnspent(half)).toBe(35);
    expect(lotRemaining(half, NOW)).toBe(35);
    expect(lotRemaining(half, NOW + 100)).toBe(0);
    expect(lotUnspent(lot("t", "top_up", 10, { consumed: 8, debtOffset: 5 }))).toBe(0);
  });

  it("rolls over the unspent balance even after expiry, capped", () => {
    expect(rolloverQuantity(lot("p", "current_period", 2000, { consumed: 500, expiresAt: NOW - 1 }))).toBe(1500);
    expect(rolloverQuantity(lot("p", "current_period", 5000))).toBe(ROLLOVER_CAP);
    expect(ROLLOVER_CAP).toBe(2000);
  });
});

describe("topUpExpiresAt", () => {
  it.each([
    ["2026-05-14T08:30:15.250Z", "2027-05-14T08:30:15.250Z"],
    ["2027-01-31T10:00:00.000Z", "2028-01-31T10:00:00.000Z"],
    ["2028-02-29T10:00:00.000Z", "2029-02-28T10:00:00.000Z"],
    ["2026-12-31T23:59:59.999Z", "2027-12-31T23:59:59.999Z"],
  ])("%s expires at %s", (settled, expires) => {
    expect(new Date(topUpExpiresAt(Date.parse(settled))).toISOString()).toBe(expires);
  });
});

describe("isInPaidPeriod", () => {
  const period = (extra: Partial<GrantLot> & { serviceStart?: number }) => ({
    ...lot("p", "current_period", 10), serviceStart: NOW - 50, ...extra,
  });
  it("needs an unexpired, started period lot, spent or not", () => {
    expect(isInPaidPeriod([period({ serviceStart: NOW })], NOW)).toBe(true);
    expect(isInPaidPeriod([period({ consumed: 10 })], NOW)).toBe(true);
    expect(isInPaidPeriod([period({ serviceStart: NOW + 1 })], NOW)).toBe(false);
    expect(isInPaidPeriod([period({ expiresAt: NOW })], NOW)).toBe(false);
    expect(isInPaidPeriod([{ ...period({}), kind: "top_up" }], NOW)).toBe(false);
    expect(isInPaidPeriod([], NOW)).toBe(false);
  });
  it("ignores a fully reversed period lot, though part of it was spent rather than revoked", () => {
    expect(isInPaidPeriod([period({ consumed: 6, revoked: 4, fullyReversed: true })], NOW)).toBe(false);
    expect(isInPaidPeriod([period({ consumed: 6, revoked: 2 })], NOW)).toBe(true);
  });
});

describe("paid credits gate", () => {
  // The gate is lifted for fulfillment only: convex/billingFulfill.ts enables an
  // account when it grants a settled payment. Everything else only reads the
  // fields, and the charge path (credits.ts) never writes them.
  it("only fulfillment enables paid credits on an account", () => {
    const mentions = ["convex", "src"].flatMap((dir) =>
      readdirSync(dir, { recursive: true, encoding: "utf8" })
        .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.includes("_generated"))
        .map((file) => join(dir, file))
        .filter((path) => /paidCredits(Version|Mode)/.test(readFileSync(path, "utf8"))),
    );
    expect(mentions.sort()).toEqual(["convex/billingFulfill.ts", "convex/billingGrants.ts", "convex/credits.ts", "convex/schema.ts"]);
    for (const reader of ["convex/billingGrants.ts", "convex/credits.ts"]) {
      expect(readFileSync(reader, "utf8")).not.toMatch(/paidCredits(Version|Mode)\s*:/);
    }
    expect(readFileSync("convex/billingFulfill.ts", "utf8")).toMatch(/paidCreditsVersion: 1 as const, paidCreditsMode:/);
  });
});
