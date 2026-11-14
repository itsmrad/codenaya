import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn(), start: vi.fn() }));
vi.mock("@/features/auth/server/require-user-id", () => ({
  requireUserId: async () => ({ userId: "alice" }),
}));
vi.mock("@/lib/convex-client", () => ({
  convex: { query: mocks.query, mutation: mocks.mutation },
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true }),
  OAUTH_START_RATE_LIMIT: {},
}));
vi.mock("@/features/integrations/server/oauth/flow", () => ({
  startOAuthFlow: mocks.start,
}));

import { POST } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
  vi.stubEnv("INTEGRATIONS_REDIRECT_URI", "http://localhost/api/integrations/oauth/callback");
});

it("refuses to reconnect a missing or foreign connection before starting OAuth", async () => {
  mocks.query.mockResolvedValue(null);
  const response = await POST(
    new Request("http://localhost/api/integrations/oauth/start", {
      method: "POST",
      body: JSON.stringify({ providerId: "supabase", connectionId: "someone-elses" }),
      headers: { "Content-Type": "application/json" },
    }),
  );
  expect(response.status).toBe(404);
  expect(mocks.query.mock.calls[0][1]).toMatchObject({
    userId: "alice", connectionId: "someone-elses", providerId: "supabase", authMode: "oauth",
  });
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.mutation).not.toHaveBeenCalled();
});
