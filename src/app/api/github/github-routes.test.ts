import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getUserOauthAccessToken: vi.fn(),
  createProject: vi.fn(),
  query: vi.fn(),
  inngestSend: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: mocks.auth,
  clerkClient: async () => ({
    users: { getUserOauthAccessToken: mocks.getUserOauthAccessToken },
  }),
}));
vi.mock("@/lib/convex-client", () => ({
  convex: { mutation: mocks.createProject, query: mocks.query },
}));
vi.mock("@/inngest/client", () => ({
  inngest: { send: mocks.inngestSend },
}));

import { POST as importPOST } from "./import/route";
import { POST as exportPOST } from "./export/route";
import { GITHUB_NOT_LINKED } from "@/features/projects/constants";

const post = (body: unknown) =>
  new Request("http://localhost/api/github", {
    method: "POST",
    body: JSON.stringify(body),
  });

const routes = [
  {
    name: "import",
    call: () => importPOST(post({ url: "https://github.com/acme/widgets" })),
  },
  {
    name: "export",
    call: () => exportPOST(post({ projectId: "p1", repoName: "widgets" })),
  },
];

describe.each(routes)("POST /api/github/$name", ({ call }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
    // `has` reports no plans: users without a "pro" plan must still be allowed.
    mocks.auth.mockResolvedValue({ userId: "user_1", has: () => false });
    mocks.createProject.mockResolvedValue("p1");
    // Export checks the caller owns the project (#208).
    mocks.query.mockResolvedValue({ _id: "p1", ownerId: "user_1" });
    mocks.inngestSend.mockResolvedValue({ ids: ["evt_1"] });
  });

  it("returns 401 when signed out", async () => {
    mocks.auth.mockResolvedValue({ userId: null, has: () => false });

    const res = await call();

    expect(res.status).toBe(401);
  });

  it("starts the job for a linked GitHub account without a pro plan", async () => {
    mocks.getUserOauthAccessToken.mockResolvedValue({
      data: [{ token: "gho_test" }],
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, eventId: "evt_1" });
    expect(mocks.inngestSend).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ githubToken: "gho_test" }),
      })
    );
  });

  it("returns GITHUB_NOT_LINKED when no GitHub account is linked", async () => {
    mocks.getUserOauthAccessToken.mockResolvedValue({ data: [] });

    const res = await call();

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: GITHUB_NOT_LINKED });
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });
});
