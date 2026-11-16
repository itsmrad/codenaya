import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), query: vi.fn(), current: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("@/lib/convex-client", () => ({ convex: { query: mocks.query } }));
vi.mock("@/features/sandbox-preview/server/current-preview-url", async original => ({ ...await original<typeof import("@/features/sandbox-preview/server/current-preview-url")>(), currentPreviewUrl: mocks.current }));
import { PreviewLookupRateLimitError } from "@/features/sandbox-preview/server/current-preview-url";

import { GET } from "./route";

const call = () => GET(new Request("https://codenaya.com/api/projects/victim/preview"), { params: Promise.resolve({ projectId: "victim" }) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
  mocks.auth.mockResolvedValue({ userId: "attacker" });
  mocks.query.mockResolvedValue(null);
});

afterEach(() => vi.unstubAllEnvs());

describe("owner preview route", () => {
  it("returns the standard 429 when the shared page/API lookup limit is exhausted", async () => {
    mocks.query.mockResolvedValue({ name: "Mine" });
    mocks.current.mockRejectedValue(new PreviewLookupRateLimitError({ allowed: false, remaining: 0, retryAfterSeconds: 15 }));
    const response = await call();
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("15");
  });
  it("returns 404 for non-owners before inspecting any sandbox", async () => {
    expect((await call()).status).toBe(404);
    expect(getFunctionName(mocks.query.mock.calls[0][0])).toBe("system:getOwnedProject");
    expect(mocks.query).toHaveBeenCalledWith(expect.anything(), { userId: "attacker", projectId: "victim", internalKey: "test-key" });
    expect(mocks.current).not.toHaveBeenCalled();
  });

  it("returns 404 when signed out", async () => {
    mocks.auth.mockResolvedValue({ userId: null });
    expect((await call()).status).toBe(404);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.current).not.toHaveBeenCalled();
  });

  it.each([null, "https://4000-current.e2b.app"])("returns the owner's current preview: %s", async (previewUrl) => {
    mocks.query.mockResolvedValue({ name: "My app" });
    mocks.current.mockResolvedValue(previewUrl);
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ name: "My app", previewUrl });
    expect(mocks.current).toHaveBeenCalledWith("victim", "attacker");
  });
});
