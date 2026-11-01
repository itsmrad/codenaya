import { describe, expect, it } from "vitest";

import {
  PROMO_ENDS_AT,
  PROMO_ENDS_LABEL,
  PROMO_OPUS_RUN_LIMIT,
  isGithubAccountOldEnough,
  isPromoActive,
  isPromoRefusalCode,
  opusRunsLeft,
  promoRunRefusal,
} from "./github-promo";

const DAY = 24 * 60 * 60 * 1000;

describe("github promo rules", () => {
  it("ends at Nov 1 2026 00:00 UTC, exclusive", () => {
    expect(new Date(PROMO_ENDS_AT).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(isPromoActive(PROMO_ENDS_AT - 1)).toBe(true);
    expect(isPromoActive(PROMO_ENDS_AT)).toBe(false);
    expect(PROMO_ENDS_LABEL).toBe("Nov 1, 00:00 UTC");
  });

  it("needs a GitHub account at least 365 days old", () => {
    const now = Date.UTC(2026, 9, 29);
    expect(isGithubAccountOldEnough(now - 365 * DAY, now)).toBe(true);
    expect(isGithubAccountOldEnough(now - 365 * DAY + 1, now)).toBe(false);
  });

  it("limits Opus runs but not Sonnet, and stops both at the end", () => {
    const opus = { kind: "opus" as const };
    const sonnet = { kind: "sonnet" as const };
    const usedUp = { opusRunsUsed: PROMO_OPUS_RUN_LIMIT };
    const before = PROMO_ENDS_AT - DAY;

    expect(promoRunRefusal({ opusRunsUsed: PROMO_OPUS_RUN_LIMIT - 1 }, opus, before)).toBeNull();
    expect(promoRunRefusal(usedUp, opus, before)).toBe("opus_used_up");
    expect(promoRunRefusal(usedUp, sonnet, before)).toBeNull();
    expect(promoRunRefusal({ opusRunsUsed: 0 }, sonnet, PROMO_ENDS_AT)).toBe("ended");
    expect(opusRunsLeft({ opusRunsUsed: PROMO_OPUS_RUN_LIMIT + 3 })).toBe(0);
  });

  it("recognises the send routes' refusal codes", () => {
    expect(isPromoRefusalCode("promo_opus_used_up")).toBe(true);
    expect(isPromoRefusalCode("ai_not_configured")).toBe(false);
    expect(isPromoRefusalCode(undefined)).toBe(false);
  });
});
