import { describe, expect, it } from "vitest";

import {
  costUsd,
  creditRefusal,
  creditStanding,
  creditsForCost,
  currentUsage,
  usageOfResponse,
} from "./credits";
import { PLANS } from "./plans";

const OCT_29 = Date.UTC(2026, 9, 29, 4, 30);
const OCT_1 = Date.UTC(2026, 9, 1);
const OCT_29_START = Date.UTC(2026, 9, 29);

describe("usageOfResponse", () => {
  it("reads OpenAI chat and Anthropic usage, Anthropic cache tokens included", () => {
    expect(usageOfResponse(JSON.stringify({ usage: { prompt_tokens: 1200, completion_tokens: 300 } }))).toEqual({
      inputTokens: 1200,
      outputTokens: 300,
    });
    expect(
      usageOfResponse(
        JSON.stringify({
          usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 25, output_tokens: 40 },
        }),
      ),
    ).toEqual({ inputTokens: 175, outputTokens: 40 });
  });

  it("is zero for a response without usage or with junk in it", () => {
    for (const raw of [undefined, "", "not json", "{}", JSON.stringify({ usage: { prompt_tokens: -5, completion_tokens: "9" } })]) {
      expect(usageOfResponse(raw)).toEqual({ inputTokens: 0, outputTokens: 0 });
    }
  });
});

describe("costs and credits", () => {
  it("prices blended and split routes per 1M tokens", () => {
    const usage = { inputTokens: 750_000, outputTokens: 250_000 };
    expect(costUsd({ mode: "blended", usdPerMTok: 8 }, usage)).toBe(8);
    expect(costUsd({ mode: "split", inputUsdPerMTok: 4, outputUsdPerMTok: 20 }, usage)).toBe(8);
  });

  it("charges cost × 1.5 in cents, rounded up, without float drift", () => {
    expect(creditsForCost(0)).toBe(0);
    expect(creditsForCost(0.1)).toBe(15);
    expect(creditsForCost(0.0001)).toBe(1);
    expect(creditsForCost(0.08)).toBe(12);
  });
});

describe("standing", () => {
  const usage = { periodStartsAt: OCT_1, periodUsed: 280, dayStartsAt: OCT_29_START, dayUsed: 55 };

  it("leaves the smaller of the month and the day on Free", () => {
    expect(creditStanding(PLANS.free, usage, OCT_29)).toEqual({
      monthLeft: 20,
      dayLeft: 5,
      left: 5,
      monthResetsAt: Date.UTC(2026, 10, 1),
      dayResetsAt: Date.UTC(2026, 9, 30),
    });
    expect(creditStanding(PLANS.pro, usage, OCT_29)).toMatchObject({ dayLeft: null, left: 1_720 });
  });

  it("resets a past day and month lazily, and never goes below 0", () => {
    const tomorrow = Date.UTC(2026, 9, 30, 1);
    expect(currentUsage(usage, tomorrow)).toMatchObject({ periodUsed: 280, dayUsed: 0 });
    expect(currentUsage(usage, Date.UTC(2026, 10, 2))).toMatchObject({ periodUsed: 0, dayUsed: 0 });
    expect(creditStanding(PLANS.free, { ...usage, dayUsed: 70 }, OCT_29).dayLeft).toBe(0);
    // December rolls into January.
    expect(creditStanding(PLANS.free, null, Date.UTC(2026, 11, 15)).monthResetsAt).toBe(Date.UTC(2027, 0, 1));
  });

  it("refuses a run once the month or the day is spent", () => {
    expect(creditRefusal(PLANS.free, null, OCT_29)).toBeNull();
    expect(creditRefusal(PLANS.free, { ...usage, dayUsed: 60 }, OCT_29)).toBe("day_used_up");
    expect(creditRefusal(PLANS.free, { ...usage, periodUsed: 300, dayUsed: 60 }, OCT_29)).toBe("month_used_up");
    // Yesterday's cap doesn't carry over.
    expect(creditRefusal(PLANS.free, { ...usage, dayUsed: 60 }, Date.UTC(2026, 9, 30, 1))).toBeNull();
  });
});
