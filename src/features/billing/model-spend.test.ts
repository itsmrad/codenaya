import { describe, expect, it } from "vitest";

import { spendPeriodStart, spendRefusal, spentInPeriod } from "./model-spend";

// Thursday Oct 29 2026, 10:00 UTC.
const NOW = Date.UTC(2026, 9, 29, 10);

describe("spendPeriodStart", () => {
  it("starts days, Monday weeks and months at UTC midnight, and never-resetting limits at 0", () => {
    expect(spendPeriodStart("daily", NOW)).toBe(Date.UTC(2026, 9, 29));
    expect(spendPeriodStart("weekly", NOW)).toBe(Date.UTC(2026, 9, 26));
    expect(spendPeriodStart("weekly", Date.UTC(2026, 10, 1, 23))).toBe(Date.UTC(2026, 9, 26)); // Sunday
    expect(spendPeriodStart("weekly", Date.UTC(2026, 10, 2))).toBe(Date.UTC(2026, 10, 2)); // Monday
    expect(spendPeriodStart("monthly", NOW)).toBe(Date.UTC(2026, 9, 1));
    expect(spendPeriodStart("never", NOW)).toBe(0);
  });
});

describe("spendRefusal", () => {
  const thisWeek = (spentUsd: number) => ({ periodStartsAt: Date.UTC(2026, 9, 26), spentUsd });

  it("refuses at the site-wide cap first, then at the user's", () => {
    const limit = { perUserUsd: 1, totalUsd: 100, resets: "weekly" as const };
    expect(spendRefusal(limit, { user: thisWeek(0.99), total: thisWeek(99) }, NOW)).toBeNull();
    expect(spendRefusal(limit, { user: thisWeek(1), total: thisWeek(99) }, NOW)).toBe("user_limit");
    expect(spendRefusal(limit, { user: thisWeek(1), total: thisWeek(100) }, NOW)).toBe("total_limit");
  });

  it("ignores spend from an earlier period and caps that aren't set", () => {
    const lastWeek = { periodStartsAt: Date.UTC(2026, 9, 19), spentUsd: 50 };
    expect(spendRefusal({ perUserUsd: 1, resets: "weekly" }, { user: lastWeek, total: null }, NOW)).toBeNull();
    expect(spentInPeriod(lastWeek, Date.UTC(2026, 9, 26))).toBe(0);
    expect(spendRefusal({ totalUsd: 10, resets: "never" }, { user: thisWeek(500), total: null }, NOW)).toBeNull();
  });
});
