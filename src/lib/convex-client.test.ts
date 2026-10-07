import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("convex client", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("imports without NEXT_PUBLIC_CONVEX_URL and fails clearly on use", async () => {
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "");
    const { convex } = await import("./convex-client");

    expect(() => convex.query).toThrow(/NEXT_PUBLIC_CONVEX_URL is not set/);
  });

  it("exposes bound client methods when configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://example.convex.cloud");
    const { convex } = await import("./convex-client");

    expect(typeof convex.query).toBe("function");
    expect(typeof convex.mutation).toBe("function");
  });
});
