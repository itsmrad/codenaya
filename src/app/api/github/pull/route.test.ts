import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getUserOauthAccessToken: vi.fn(),
  query: vi.fn(),
  inngestSend: vi.fn(),
  getRef: vi.fn(),
  getCommit: vi.fn(),
  getTree: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: mocks.auth,
  clerkClient: async () => ({
    users: { getUserOauthAccessToken: mocks.getUserOauthAccessToken },
  }),
}));
vi.mock("@/lib/convex-client", () => ({
  convex: { mutation: vi.fn(), query: mocks.query },
}));
vi.mock("@/inngest/client", () => ({
  inngest: { send: mocks.inngestSend, createFunction: () => ({}) },
}));
vi.mock("octokit", () => ({
  Octokit: class {
    rest = { git: { getRef: mocks.getRef, getCommit: mocks.getCommit, getTree: mocks.getTree } };
  },
  RequestError: class extends Error {},
}));

import { POST } from "./route";
import { gitBlobSha } from "@/features/projects/inngest/push-to-github";
import { GITHUB_SYNC_CONFLICT } from "@/features/projects/constants";

const LINKED = { repo: "octocat/widgets", branch: "main", lastSyncedSha: "synced", lastSyncedAt: 1 };

const pull = (body: object = {}) =>
  POST(
    new Request("http://localhost/api/github/pull", {
      method: "POST",
      body: JSON.stringify({ projectId: "p1", ...body }),
    })
  );

/** The project's files, as `getProjectFilesWithUrls` returns them. */
const localFiles = (files: Record<string, string>) =>
  Object.entries(files).map(([name, content]) => ({ _id: name, name, type: "file", content }));

/** The tree of the last synced commit. */
const syncedTree = (files: Record<string, string>) =>
  mocks.getTree.mockResolvedValue({
    data: {
      tree: Object.entries(files).map(([path, content]) => ({
        path,
        type: "blob",
        sha: gitBlobSha(Buffer.from(content)),
      })),
    },
  });

/** A linked project with these files, and the branch's head on GitHub. */
function given({ head, files, sync = LINKED }: { head: string; files: Record<string, string>; sync?: object }) {
  mocks.query.mockImplementation(async (_fn, args: { userId?: string }) =>
    args.userId ? { _id: "p1", ownerId: "user_1", githubSync: sync } : localFiles(files)
  );
  mocks.getRef.mockResolvedValue({ data: { object: { sha: head } } });
}

describe("POST /api/github/pull: when the conflict dialog shows (#343)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
    mocks.auth.mockResolvedValue({ userId: "user_1", has: () => false });
    mocks.getUserOauthAccessToken.mockResolvedValue({ data: [{ token: "gho_test" }] });
    mocks.inngestSend.mockResolvedValue({ ids: ["evt_1"] });
    mocks.getCommit.mockResolvedValue({ data: { tree: { sha: "tree" } } });
    syncedTree({ "index.html": "<h1>v1</h1>" });
  });

  it("does nothing while the remote is where the last sync left it, local changes or not", async () => {
    given({ head: "synced", files: { "index.html": "<h1>edited here</h1>" } });

    const res = await pull();

    expect(await res.json()).toEqual({ upToDate: true });
    expect(mocks.getTree).not.toHaveBeenCalled();
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("pulls the remote head when only the remote moved", async () => {
    given({ head: "remote", files: { "index.html": "<h1>v1</h1>" } });

    const res = await pull();

    expect(res.status).toBe(200);
    expect(mocks.getCommit).toHaveBeenCalledWith(expect.objectContaining({ commit_sha: "synced" }));
    expect(mocks.inngestSend).toHaveBeenCalledWith({
      name: "github/sync.pull",
      data: { projectId: "p1", userId: "user_1", sha: "remote" },
    });
  });

  it.each([
    ["an edited file", { "index.html": "<h1>edited here</h1>" }],
    ["an added file", { "index.html": "<h1>v1</h1>", "about.html": "hi" }],
    ["a deleted file", {}],
  ])("asks first when both sides changed: %s", async (_, files) => {
    given({ head: "remote", files });

    const res = await pull();

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: GITHUB_SYNC_CONFLICT });
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("overwrites local once the user chose to", async () => {
    given({ head: "remote", files: { "index.html": "<h1>edited here</h1>" } });

    const res = await pull({ overwrite: true });

    expect(res.status).toBe(200);
    expect(mocks.inngestSend.mock.calls[0][0].data).toMatchObject({ sha: "remote" });
  });

  it("compares with the sync branch when the last push went there", async () => {
    given({ head: "remote", files: { "index.html": "<h1>v1</h1>" }, sync: { ...LINKED, syncBranchSha: "side", syncBranchAt: 2 } });

    await pull();

    expect(mocks.getCommit).toHaveBeenCalledWith(expect.objectContaining({ commit_sha: "side" }));
  });

  it("refuses a project that was never exported", async () => {
    mocks.query.mockResolvedValue({ _id: "p1", ownerId: "user_1" });

    const res = await pull();

    expect(res.status).toBe(400);
    expect(mocks.getRef).not.toHaveBeenCalled();
  });
});
