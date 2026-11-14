import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  mutation: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("@/lib/convex-client", () => ({ convex: { mutation: mocks.mutation } }));

import { resetRateLimits, WAITLIST_RATE_LIMIT } from "@/lib/rate-limit";
import { POST } from "./route";

const post = (body: unknown, ip = "203.0.113.7") =>
  POST(
    new Request("http://localhost/api/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
  mocks.auth.mockResolvedValue({ userId: null });
  mocks.mutation.mockResolvedValue(null);
  resetRateLimits();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  resetRateLimits();
});

describe("POST /api/waitlist (#250)", () => {
  it("stores a valid email, lowercased, with the signed-in user", async () => {
    mocks.auth.mockResolvedValue({ userId: "user_1" });
    const response = await post({ email: " Ada@Example.com " });

    expect(response.status).toBe(200);
    expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), {
      internalKey: "ik",
      email: "ada@example.com",
      userId: "user_1",
    });
  });

  it("refuses an invalid email with 400 and stores nothing", async () => {
    expect((await post({ email: "not-an-email" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("rate-limits by client IP", async () => {
    for (let i = 0; i < WAITLIST_RATE_LIMIT.limit; i++) {
      expect((await post({ email: `a${i}@example.com` })).status).toBe(200);
    }
    expect((await post({ email: "late@example.com" })).status).toBe(429);
    // Another visitor is unaffected.
    expect((await post({ email: "other@example.com" }, "198.51.100.2")).status).toBe(200);
  });
});
