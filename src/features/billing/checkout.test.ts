import { describe, expect, it } from "vitest";

import { checkoutErrorMessage } from "./checkout";

describe("checkoutErrorMessage", () => {
  it("maps known codes before statuses", () => {
    expect(checkoutErrorMessage(409, "already_subscribed")).toBe("You're already on Pro.");
    expect(checkoutErrorMessage(403, "billing_on_hold")).toMatch(/on hold/);
    expect(checkoutErrorMessage(409, "top_up_cap")).toMatch(/limit/);
  });

  it("falls back to the status, then to a generic message", () => {
    expect(checkoutErrorMessage(401)).toMatch(/Sign in/);
    expect(checkoutErrorMessage(429, "rate_limited")).toMatch(/Too many/);
    expect(checkoutErrorMessage(503)).toMatch(/temporarily unavailable/);
    expect(checkoutErrorMessage(500)).toBe("Couldn't start checkout. Try again.");
  });

  it("ignores codes that aren't its own, including prototype keys", () => {
    expect(checkoutErrorMessage(409, "constructor")).toBe("Couldn't start checkout. Try again.");
    expect(checkoutErrorMessage(409, 42)).toBe("Couldn't start checkout. Try again.");
  });
});
