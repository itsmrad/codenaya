import { describe, expect, it } from "vitest";

import { formatUsd, monthKey, usageLimitMessage, usageStatus } from "./limits";

describe("limits", () => {
  it("months are UTC", () => {
    expect(monthKey(Date.UTC(2026, 9, 31, 23, 59, 59))).toBe("2026-10");
    expect(monthKey(Date.UTC(2026, 10, 1))).toBe("2026-11");
  });

  it("names the cap, the plan, the reset and the way out", () => {
    const usd = usageStatus("free", { costLimitMicroUsd: 3_000_000 }, { costMicroUsd: 3_000_000, tokens: 0 });
    expect(usageLimitMessage(usd, "2026-12")).toBe(
      "You've used your Free plan's $3.00 of Codenaya AI for December. It resets on January 1. " +
        "Add your own API key in Settings → AI providers to keep going.",
    );
    const tokens = usageStatus("pro", { tokenLimit: 2_000_000 }, { costMicroUsd: 0, tokens: 2_000_000 });
    expect(usageLimitMessage(tokens, "2026-10")).toMatch(/Pro plan's 2,000,000 tokens .* November 1/);
  });

  it("shows sub-cent amounts instead of rounding them to $0.00", () => {
    expect(formatUsd(1_000)).toBe("$0.001");
    expect(formatUsd(1_856)).toBe("$0.0019");
    expect(formatUsd(1_234_567)).toBe("$1.23");
  });
});
