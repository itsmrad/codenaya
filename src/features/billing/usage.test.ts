import { describe, expect, test } from "vitest";

import { formatResetTime, runCostLabel, usageView } from "./usage";

const NOV_15 = Date.UTC(2026, 10, 15, 10);
const account = {
  plan: "free" as const,
  periodStartsAt: Date.UTC(2026, 10, 1),
  periodUsed: 100,
  dayStartsAt: Date.UTC(2026, 10, 15),
  dayUsed: 30,
};

describe("usageView", () => {
  test("no account yet shows the full free grant", () => {
    expect(usageView(null, NOV_15)).toMatchObject({
      plan: { id: "free" },
      month: { left: 300, total: 300, percentLeft: 100 },
      day: { left: 60, total: 60, percentLeft: 100 },
      monthResetsAt: Date.UTC(2026, 11, 1),
      dayResetsAt: Date.UTC(2026, 10, 16),
      isLow: false,
    });
  });

  test("partial use", () => {
    expect(usageView(account, NOV_15)).toMatchObject({
      month: { left: 200, percentLeft: 67 },
      day: { left: 30, percentLeft: 50 },
      isLow: false,
    });
    // 10 of 60 left today is under 20%.
    expect(usageView({ ...account, dayUsed: 50 }, NOV_15).isLow).toBe(true);
  });

  test("exhausted, even past the grant", () => {
    expect(usageView({ ...account, periodUsed: 310 }, NOV_15)).toMatchObject({
      month: { left: 0, percentLeft: 0 },
      isLow: true,
    });
  });

  test("a reset that has passed counts as unused", () => {
    const nextDay = Date.UTC(2026, 10, 16, 1);
    expect(usageView({ ...account, dayUsed: 60 }, nextDay)).toMatchObject({
      day: { left: 60 },
      month: { left: 200 },
      isLow: false,
    });
    expect(usageView({ ...account, periodUsed: 300 }, Date.UTC(2026, 11, 1, 1)).month.left).toBe(300);
  });

  test("re-derived at the reset time, a fully used day is full again (#552)", () => {
    const usedUp = usageView({ ...account, dayUsed: 60 }, NOV_15);
    expect(usedUp.day).toMatchObject({ left: 0 });
    expect(usageView({ ...account, dayUsed: 60 }, usedUp.dayResetsAt).day).toMatchObject({ left: 60, percentLeft: 100 });
  });

  test("a daily reset leaves an exhausted month empty until the UTC year boundary", () => {
    const used = { ...account, periodStartsAt: Date.UTC(2026, 11, 1), periodUsed: 300,
      dayStartsAt: Date.UTC(2026, 11, 30), dayUsed: 60 };
    expect(usageView(used, Date.UTC(2026, 11, 31))).toMatchObject({
      day: { left: 60 }, month: { left: 0 }, isLow: true,
    });
    expect(usageView(used, Date.UTC(2027, 0, 1))).toMatchObject({
      day: { left: 60 }, month: { left: 300 }, isLow: false,
      dayResetsAt: Date.UTC(2027, 0, 2), monthResetsAt: Date.UTC(2027, 1, 1),
    });
  });

  test("a plan without a daily cap has no day bar", () => {
    expect(usageView({ ...account, plan: "pro" }, NOV_15)).toMatchObject({ day: null, month: { left: 1_900 } });
  });
});

describe("formatResetTime", () => {
  test("shows the time in the viewer's zone, with its name", () => {
    // Some ICU versions put a narrow no-break space before "AM".
    const reset = (timeZone: string) => formatResetTime(Date.UTC(2026, 10, 16), timeZone).replace(/\u202f/g, " ");
    expect(reset("UTC")).toBe("Nov 16, 12:00 AM UTC");
    expect(reset("Asia/Kolkata")).toBe("Nov 16, 5:30 AM GMT+5:30");
  });
});

describe("runCostLabel", () => {
  test("shows credits as dollars, nothing for a free run", () => {
    expect(runCostLabel(4)).toBe("≈ $0.04");
    expect(runCostLabel(0)).toBeNull();
    expect(runCostLabel(null)).toBeNull();
  });
});
