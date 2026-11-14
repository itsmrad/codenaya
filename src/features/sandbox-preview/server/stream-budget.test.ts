import { describe, expect, it } from "vitest";

import {
  CLOSE_BUDGET_MS,
  STREAM_BUDGET_MS,
  boundedTimeout,
  streamBudget,
} from "./stream-budget";

describe("streamBudget (#492)", () => {
  it("ends the stream and closes the function before Vercel's 300 s limit", () => {
    expect(STREAM_BUDGET_MS).toBeLessThan(CLOSE_BUDGET_MS);
    expect(CLOSE_BUDGET_MS).toBeLessThan(300_000);
  });

  it("counts down from the request's start", () => {
    let now = 1_000;
    const budget = streamBudget(1_000, () => now);

    expect(budget.left()).toBe(STREAM_BUDGET_MS);
    expect(budget.closeLeft()).toBe(CLOSE_BUDGET_MS);

    now += STREAM_BUDGET_MS + 5_000;
    expect(budget.left()).toBe(-5_000);
    expect(budget.closeLeft()).toBe(CLOSE_BUDGET_MS - STREAM_BUDGET_MS - 5_000);
  });
});

describe("boundedTimeout", () => {
  it("keeps the step's own timeout while there is time", () => {
    expect(boundedTimeout(60_000, 200_000)).toBe(60_000);
  });

  it("shortens it to what is left", () => {
    expect(boundedTimeout(300_000, 42_000)).toBe(42_000);
  });

  it("never returns 0 or less, which E2B would read as no timeout", () => {
    expect(boundedTimeout(300_000, 0)).toBe(1_000);
    expect(boundedTimeout(300_000, -10_000)).toBe(1_000);
  });
});
