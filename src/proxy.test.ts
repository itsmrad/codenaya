import { describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: vi.fn(() => vi.fn()),
  createRouteMatcher: vi.fn(() => vi.fn()),
}));
vi.mock("@/features/admin/server/require-admin", () => ({ adminOrNull: vi.fn() }));

import { config } from "./proxy";

// Next.js matches a path when ANY matcher entry matches.
const runsMiddleware = (path: string) =>
  config.matcher.some((pattern) => new RegExp(`^${pattern}$`).test(path));

describe("proxy matcher", () => {
  it("skips /api/inngest (Inngest verifies its own signing key)", () => {
    expect(runsMiddleware("/api/inngest")).toBe(false);
  });

  it("still runs for other API routes and pages", () => {
    expect(runsMiddleware("/api/sandbox")).toBe(true);
    expect(runsMiddleware("/api/sandbox/abc")).toBe(true);
    expect(runsMiddleware("/trpc/foo")).toBe(true);
    expect(runsMiddleware("/admin")).toBe(true);
    expect(runsMiddleware("/")).toBe(true);
  });

  it("still skips Next internals and static files", () => {
    expect(runsMiddleware("/_next/static/chunk.js")).toBe(false);
    expect(runsMiddleware("/logo.png")).toBe(false);
  });
});
