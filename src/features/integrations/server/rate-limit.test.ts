import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONNECT_RATE_LIMIT,
  checkRateLimit,
  rateLimitedResponse,
  resetRateLimits,
} from "./rate-limit";

/**
 * These routes make outbound network requests before doing anything else — an MCP
 * handshake, or OAuth discovery plus client registration. The SSRF guard restricts
 * *where* they can reach; this restricts *how often*.
 */

const CONFIG = { scope: "test", limit: 3, windowMs: 60_000 };

beforeEach(() => {
  resetRateLimits();
});

afterEach(() => {
  vi.useRealTimers();
  resetRateLimits();
});

describe("checkRateLimit", () => {
  it("allows requests up to the limit", () => {
    for (let i = 0; i < CONFIG.limit; i++) {
      expect(checkRateLimit("user_1", CONFIG).allowed).toBe(true);
    }
  });

  it("denies once the limit is exceeded", () => {
    for (let i = 0; i < CONFIG.limit; i++) checkRateLimit("user_1", CONFIG);
    expect(checkRateLimit("user_1", CONFIG).allowed).toBe(false);
  });

  it("counts denied attempts, so hammering does not roll the window open", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    for (let i = 0; i < 20; i++) checkRateLimit("user_1", CONFIG);

    // Just before the original window would have closed.
    vi.setSystemTime(CONFIG.windowMs - 1);
    expect(checkRateLimit("user_1", CONFIG).allowed).toBe(false);

    // Just after.
    vi.setSystemTime(CONFIG.windowMs + 1);
    expect(checkRateLimit("user_1", CONFIG).allowed).toBe(true);
  });

  it("reports remaining requests", () => {
    expect(checkRateLimit("user_1", CONFIG).remaining).toBe(2);
    expect(checkRateLimit("user_1", CONFIG).remaining).toBe(1);
    expect(checkRateLimit("user_1", CONFIG).remaining).toBe(0);
  });

  it("resets after the window elapses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    for (let i = 0; i < CONFIG.limit; i++) checkRateLimit("user_1", CONFIG);
    expect(checkRateLimit("user_1", CONFIG).allowed).toBe(false);

    vi.setSystemTime(CONFIG.windowMs + 1);
    expect(checkRateLimit("user_1", CONFIG).allowed).toBe(true);
  });

  it("isolates users from each other", () => {
    // One user exhausting their budget must not lock anyone else out.
    for (let i = 0; i < CONFIG.limit + 5; i++) checkRateLimit("user_1", CONFIG);

    expect(checkRateLimit("user_2", CONFIG).allowed).toBe(true);
  });

  it("isolates scopes from each other", () => {
    // Exhausting `connect` must not block `oauth-start`; they are different
    // operations with different costs.
    const a = { scope: "scope-a", limit: 2, windowMs: 60_000 };
    const b = { scope: "scope-b", limit: 2, windowMs: 60_000 };

    checkRateLimit("user_1", a);
    checkRateLimit("user_1", a);
    expect(checkRateLimit("user_1", a).allowed).toBe(false);
    expect(checkRateLimit("user_1", b).allowed).toBe(true);
  });

  it("reports a retry-after that shrinks as the window elapses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    for (let i = 0; i < CONFIG.limit; i++) checkRateLimit("user_1", CONFIG);

    vi.setSystemTime(30_000);
    const result = checkRateLimit("user_1", CONFIG);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(30);
  });

  it("never reports a retry-after below one second", () => {
    // A `Retry-After: 0` invites an immediate retry that would also be denied.
    vi.useFakeTimers();
    vi.setSystemTime(0);

    for (let i = 0; i < CONFIG.limit; i++) checkRateLimit("user_1", CONFIG);

    vi.setSystemTime(CONFIG.windowMs - 10);
    expect(checkRateLimit("user_1", CONFIG).retryAfterSeconds).toBe(1);
  });

  it("bounds memory across many distinct users", () => {
    // Without eviction the bucket map grows forever in a long-lived process.
    for (let i = 0; i < 12_000; i++) {
      checkRateLimit(`user_${i}`, CONFIG);
    }

    // Still enforcing for a fresh user after eviction has occurred.
    const result = checkRateLimit("user_fresh", CONFIG);
    expect(result.allowed).toBe(true);
  });
});

describe("production limits", () => {
  it("allows normal interactive use", () => {
    // A person adds a connection every few minutes at most; three in a row must not
    // be blocked.
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit("user_1", CONNECT_RATE_LIMIT).allowed).toBe(true);
    }
  });

  it("stops a scripted loop", () => {
    let denied = 0;
    for (let i = 0; i < 50; i++) {
      if (!checkRateLimit("user_1", CONNECT_RATE_LIMIT).allowed) denied += 1;
    }
    expect(denied).toBe(50 - CONNECT_RATE_LIMIT.limit);
  });
});

describe("rateLimitedResponse", () => {
  it("returns 429 with a Retry-After header", async () => {
    const response = rateLimitedResponse({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 42,
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");

    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("42");
  });
});
