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
import { POST as pushPOST } from "./push/route";
import { GITHUB_NOT_LINKED } from "@/features/projects/constants";
import {
  GITHUB_IMPORT_RATE_LIMIT,
  checkRateLimit,
  resetRateLimits,
} from "@/lib/rate-limit";

beforeEach(() => {
  resetRateLimits();
});

const post = (body: unknown) =>
  new Request("http://localhost/api/github", {
    method: "POST",
    body: JSON.stringify(body),
  });

const LINKED = {
  repo: "octocat/widgets",
  branch: "main",
  lastSyncedSha: "abc",
  lastSyncedAt: 1,
};

const routes = [
  {
    name: "import",
    call: () => importPOST(post({ url: "https://github.com/acme/widgets" })),
  },
  {
    name: "export",
    call: () => exportPOST(post({ projectId: "p1", repoName: "widgets" })),
  },
  {
    name: "push",
    call: () => pushPOST(post({ projectId: "p1" })),
    githubSync: LINKED,
  },
];

describe.each(routes)("POST /api/github/$name", ({ call, githubSync }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
    // `has` reports no plans: users without a "pro" plan must still be allowed.
    mocks.auth.mockResolvedValue({ userId: "user_1", has: () => false });
    mocks.createProject.mockResolvedValue("p1");
    // Export checks the caller owns the project (#208).
    mocks.query.mockResolvedValue({ _id: "p1", ownerId: "user_1", githubSync });
    mocks.inngestSend.mockResolvedValue({ ids: ["evt_1"] });
    // The import route checks GitHub for public repos (#364): private by default.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
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
    // Inngest stores event payloads: the job resolves the token itself (#211).
    const [{ data }] = mocks.inngestSend.mock.calls[0];
    expect(data).toMatchObject({ projectId: "p1", userId: "user_1" });
    expect(data).not.toHaveProperty("githubToken");
    expect(data).not.toHaveProperty("internalKey");
    expect(JSON.stringify(data)).not.toMatch(/gho_test|test-key/);
  });

  it("returns GITHUB_NOT_LINKED when no GitHub account is linked", async () => {
    mocks.getUserOauthAccessToken.mockResolvedValue({ data: [] });

    const res = await call();

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: GITHUB_NOT_LINKED });
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });
});

describe("GitHub sync link (#343)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
    mocks.auth.mockResolvedValue({ userId: "user_1", has: () => false });
    mocks.getUserOauthAccessToken.mockResolvedValue({ data: [{ token: "gho_test" }] });
  });

  it("never exports a linked project to a new repo", async () => {
    mocks.query.mockResolvedValue({ _id: "p1", ownerId: "user_1", githubSync: LINKED });

    const res = await exportPOST(post({ projectId: "p1", repoName: "widgets" }));

    expect(res.status).toBe(409);
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("refuses to push a project that was never exported", async () => {
    mocks.query.mockResolvedValue({ _id: "p1", ownerId: "user_1" });

    const res = await pushPOST(post({ projectId: "p1" }));

    expect(res.status).toBe(400);
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });
});

describe("POST /api/github/import without a linked GitHub account (#364)", () => {
  const importRepo = () =>
    importPOST(post({ url: "https://github.com/octocat/Hello-World" }));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
    mocks.auth.mockResolvedValue({ userId: "user_1", has: () => false });
    mocks.getUserOauthAccessToken.mockResolvedValue({ data: [] });
    mocks.createProject.mockResolvedValue("p1");
    mocks.inngestSend.mockResolvedValue({ ids: ["evt_1"] });
  });

  it("imports a public repo", async () => {
    const fetchMock = vi.fn(async () => Response.json({ private: false }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await importRepo();

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/octocat/Hello-World",
      expect.anything()
    );
    expect(mocks.inngestSend.mock.calls[0][0].data).toMatchObject({
      owner: "octocat",
      repo: "Hello-World",
      userId: "user_1",
    });
  });

  it("imports a URL that points inside the repo as owner/repo (#231)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ private: false })));

    const res = await importPOST(
      post({ url: "https://github.com/octocat/Hello-World/tree/main/docs?x=1#top" })
    );

    expect(res.status).toBe(200);
    expect(mocks.inngestSend.mock.calls[0][0].data).toMatchObject({
      owner: "octocat",
      repo: "Hello-World",
    });
  });

  it.each([
    ["private", () => Response.json({ private: true })],
    ["missing", () => new Response("", { status: 404 })],
  ])("asks to connect GitHub for a %s repo", async (_, respond) => {
    vi.stubGlobal("fetch", vi.fn(async () => respond()));

    const res = await importRepo();

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: GITHUB_NOT_LINKED,
      error: expect.stringMatching(/private/),
    });
    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("answers 429 past the per-user rate limit without creating a project (#242)", async () => {
    for (let i = 0; i < GITHUB_IMPORT_RATE_LIMIT.limit; i++) {
      checkRateLimit("user_1", GITHUB_IMPORT_RATE_LIMIT);
    }

    const res = await importRepo();

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(mocks.createProject).not.toHaveBeenCalled();
  });
});

describe("POST /api/github/import with a non-GitHub URL (#235)", () => {
  it("answers 400 without creating a project", async () => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ userId: "user_1", has: () => false });

    const res = await importPOST(post({ url: "https://gitlab.com/acme/widgets" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid GitHub URL" });
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it("rejects a github.com path smuggled into another URL (#231)", async () => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ userId: "user_1", has: () => false });

    const res = await importPOST(
      post({ url: "https://evil.com/?next=https://github.com/acme/widgets" })
    );

    expect(res.status).toBe(400);
    expect(mocks.createProject).not.toHaveBeenCalled();
  });
});
