import { describe, expect, it } from "vitest";

import {
  costUsd,
  creditRefusal,
  creditStanding,
  creditsForCost,
  currentUsage,
  minRunCredits,
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
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(
      usageOfResponse(
        JSON.stringify({
          usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 25, output_tokens: 40 },
        }),
      ),
    ).toEqual({ inputTokens: 175, outputTokens: 40, cacheReadTokens: 25, cacheWriteTokens: 50 });
  });

  it("reads OpenRouter cache tokens for Claude only", () => {
    const usage = {
      prompt_tokens: 10_000,
      completion_tokens: 60,
      prompt_tokens_details: { cached_tokens: 8_000, cache_write_tokens: 1_500 },
    };
    expect(usageOfResponse(JSON.stringify({ model: "anthropic/claude-sonnet-5.5", usage }))).toEqual({
      inputTokens: 10_000,
      outputTokens: 60,
      cacheReadTokens: 8_000,
      cacheWriteTokens: 1_500,
    });
    // Other models' cache rates vary: their cached input stays at full price.
    expect(usageOfResponse(JSON.stringify({ model: "openai/gpt-5.5", usage }))).toMatchObject({
      inputTokens: 10_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("is zero for a response without usage or with junk in it", () => {
    for (const raw of [undefined, "", "not json", "{}", JSON.stringify({ usage: { prompt_tokens: -5, completion_tokens: "9" } })]) {
      expect(usageOfResponse(raw)).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    }
  });
});

describe("costs and credits", () => {
  it("prices blended and split routes per 1M tokens", () => {
    const usage = { inputTokens: 750_000, outputTokens: 250_000 };
    expect(costUsd({ mode: "blended", usdPerMTok: 8 }, usage)).toBe(8);
    expect(costUsd({ mode: "split", inputUsdPerMTok: 4, outputUsdPerMTok: 20 }, usage)).toBe(8);
  });

  it("prices cache reads at 0.1x and cache writes at 1.25x the input price", () => {
    const split = { mode: "split", inputUsdPerMTok: 4, outputUsdPerMTok: 20 } as const;
    // 1M in: 200k uncached, 600k read, 200k written; no output.
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 600_000, cacheWriteTokens: 200_000 };
    // 0.2 × $4 + 0.6 × $0.40 + 0.2 × $5 = $0.80 + $0.24 + $1.00
    expect(costUsd(split, usage)).toBeCloseTo(2.04, 10);
    expect(costUsd({ mode: "blended", usdPerMTok: 8 }, usage)).toBeCloseTo(4.08, 10);
    // The same input uncached costs $4: a cache hit is never charged full price.
    expect(costUsd(split, { inputTokens: 1_000_000, outputTokens: 0 })).toBe(4);
  });

  it("charges a cached agent step about a third of an uncached one", () => {
    const split = { mode: "split", inputUsdPerMTok: 2, outputUsdPerMTok: 10 } as const;
    const step = (cached: number) => costUsd(split, { inputTokens: 30_000, outputTokens: 1_000, cacheReadTokens: cached });
    expect(step(0)).toBeCloseTo(0.07, 10);
    // 27k of 30k read from the cache: 3k × $2 + 27k × $0.20 + 1k × $10, per 1M.
    expect(step(27_000)).toBeCloseTo(0.0214, 10);
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

  it("refuses a run the credits left can't cover one step of (#643)", () => {
    // Sonnet 5.5's price: 30k in, 2k out is $0.08, so 12 credits.
    const sonnet = minRunCredits({ mode: "split", inputUsdPerMTok: 2, outputUsdPerMTok: 10 });
    expect(sonnet).toBe(12);
    expect(minRunCredits(undefined)).toBe(1);
    expect(minRunCredits({ mode: "blended", usdPerMTok: 0 })).toBe(1);
    // 7 left today, as in the issue.
    expect(creditRefusal(PLANS.free, { ...usage, dayUsed: 53 }, OCT_29, sonnet)).toBe("day_used_up");
    expect(creditRefusal(PLANS.free, { ...usage, dayUsed: 48 }, OCT_29, sonnet)).toBeNull();
    expect(creditRefusal(PLANS.pro, { ...usage, periodUsed: 1_995 }, OCT_29, sonnet)).toBe("month_used_up");
    expect(creditRefusal(PLANS.pro, { ...usage, periodUsed: 1_988 }, OCT_29, sonnet)).toBeNull();
  });
});
