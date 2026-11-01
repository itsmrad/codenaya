import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getUserOauthAccessToken: vi.fn(),
  mutation: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: mocks.auth,
  clerkClient: async () => ({
    users: { getUserOauthAccessToken: mocks.getUserOauthAccessToken },
  }),
}));
vi.mock("@/lib/convex-client", () => ({
  convex: { mutation: mocks.mutation },
}));

import { PROMO_ENDS_AT } from "@/features/promotions/github-promo";
import { resetRateLimits } from "@/lib/rate-limit";

import { POST } from "./route";

const GITHUB_USER = { id: 583231, login: "octocat", created_at: "2011-01-25T18:44:36Z" };

const githubAnswers = (res: Response) => vi.stubGlobal("fetch", vi.fn(async () => res));

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  resetRateLimits();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PROMO_ENDS_AT - 60_000);
  mocks.auth.mockResolvedValue({ userId: "user_1" });
  mocks.getUserOauthAccessToken.mockResolvedValue({ data: [{ token: "gho_test" }] });
  mocks.mutation.mockResolvedValue(null);
  githubAnswers(Response.json(GITHUB_USER));
});

describe("POST /api/promotions/claim", () => {
  it("returns 401 when signed out", async () => {
    mocks.auth.mockResolvedValue({ userId: null });
    expect((await POST()).status).toBe(401);
  });

  it("claims with the account GitHub reports for the user's own token", async () => {
    const res = await POST();

    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer gho_test" }),
      }),
    );
    expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), {
      internalKey: "test-key",
      userId: "user_1",
      githubUserId: 583231,
      githubLogin: "octocat",
      githubCreatedAt: Date.parse(GITHUB_USER.created_at),
    });
  });

  it("asks to connect GitHub when none is linked, or GitHub refuses the token", async () => {
    mocks.getUserOauthAccessToken.mockResolvedValue({ data: [] });
    expect(await (await POST()).json()).toMatchObject({ code: "github_not_linked" });

    mocks.getUserOauthAccessToken.mockResolvedValue({ data: [{ token: "gho_revoked" }] });
    githubAnswers(new Response("", { status: 401 }));
    const res = await POST();
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "github_not_linked" });
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("answers 502 to retry when GitHub fails, claiming nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    githubAnswers(new Response("", { status: 503 }));

    const res = await POST();

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "github_unavailable" });
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("maps Convex's refusal to its code and status", async () => {
    mocks.mutation.mockRejectedValue(
      new ConvexError({ code: "FORBIDDEN", message: "too new", reason: "github_too_new" }),
    );
    const res = await POST();

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: "github_too_new",
      error: expect.stringContaining("365 days"),
    });
  });

  it("refuses after the end without asking GitHub", async () => {
    vi.setSystemTime(PROMO_ENDS_AT);
    const res = await POST();

    expect(res.status).toBe(410);
    expect(fetch).not.toHaveBeenCalled();
  });
});
