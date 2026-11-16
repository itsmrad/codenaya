import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), owned: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: (handler: unknown) => handler,
  createRouteMatcher: () => () => false,
}));
vi.mock("@/features/admin/server/require-admin", () => ({ adminOrNull: vi.fn() }));
vi.mock("@/features/projects/server/owner-preview", () => ({ ownerPreviewProject: mocks.owned }));
import proxy from "./proxy";

// Clerk supplies this handler's session in production.
const invoke = proxy as unknown as (auth: typeof mocks.auth, request: NextRequest) => Promise<Response | undefined>;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ userId: "viewer" });
});

describe("owner preview page access", () => {
  it("returns an HTTP 404 for non-owners before streaming the page", async () => {
    mocks.owned.mockResolvedValue(null);
    const response = await invoke(mocks.auth, new NextRequest("https://codenaya.com/p/victim/preview"));
    expect(response?.status).toBe(404);
    expect(mocks.owned).toHaveBeenCalledWith("victim", { userId: "viewer" });
  });

  it("returns 404 when signed out", async () => {
    mocks.auth.mockResolvedValue({ userId: null });
    mocks.owned.mockResolvedValue(null);
    const response = await invoke(mocks.auth, new NextRequest("https://codenaya.com/p/mine/preview"));
    expect(response?.status).toBe(404);
  });

  it("lets the owner reach the page", async () => {
    mocks.owned.mockResolvedValue({ project: { name: "Mine" }, userId: "viewer" });
    expect(await invoke(mocks.auth, new NextRequest("https://codenaya.com/p/mine/preview"))).toBeUndefined();
  });
});
