import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), query: vi.fn(), mutation: vi.fn() }));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("@/lib/convex-client", () => ({
  convex: { query: mocks.query, mutation: mocks.mutation },
}));

import { resetRateLimits } from "@/lib/rate-limit";

import { POST } from "./route";

const element = { tag: "h1", text: "Hello", domPath: "main > h1", outerHTML: "<h1>Hello</h1>" };

describe("POST /api/messages elements (#227)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "internal");
    mocks.auth.mockResolvedValue({ userId: "user_1" });
  });

  it("returns 400 for more than 3 elements, before touching Convex", async () => {
    const res = await POST(
      new Request("http://localhost/api/messages", {
        method: "POST",
        body: JSON.stringify({
          conversationId: "c1",
          message: "make this red",
          model: { modelId: "auto" },
          elements: Array(4).fill(element),
        }),
      }),
    );

    expect(res.status).toBe(400);
    expect(Object.keys((await res.json()).details)).toEqual(["elements"]);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});
