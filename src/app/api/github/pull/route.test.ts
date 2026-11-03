import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getUserOauthAccessToken: vi.fn(),
  query: vi.fn(),
  inngestSend: vi.fn(),
  getRef: vi.fn(),
  getCommit: vi.fn(),
  getTree: vi.fn(),
  compare: vi.fn(),
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
    rest = {
      git: { getRef: mocks.getRef, getCommit: mocks.getCommit, getTree: mocks.getTree },
      repos: { compareCommitsWithBasehead: mocks.compare },
    };
  },
  RequestError: class extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly options: { response?: { headers: Record<string, string> } } = {}
    ) {
      super(message);
    }
    get response() {
      return this.options.response;
    }
  },
}));

import { RequestError } from "octokit";
import { POST } from "./route";
import { gitBlobSha } from "@/features/projects/inngest/push-to-github";
import { GITHUB_NOT_LINKED, GITHUB_SYNC_CONFLICT } from "@/features/projects/constants";

/** An Octokit request failure with this status and response headers. */
const githubError = (status: number, headers: Record<string, string> = {}) =>
  new RequestError("GitHub error", status, {
    request: { method: "GET", url: "https://api.github.com", headers: {} },
    response: { status, url: "https://api.github.com", data: null, headers },
  });

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
function given({
  head,
  files,
  sync = LINKED,
  running = false,
}: {
  head: string;
  files: Record<string, string>;
  sync?: object;
  running?: boolean;
}) {
  mocks.query.mockImplementation(async (fn) => {
    const name = getFunctionName(fn);
    if (name.endsWith("isAgentRunning")) return running;
    if (name.endsWith("getProjectFilesWithUrls")) return localFiles(files);
    return { _id: "p1", ownerId: "user_1", githubSync: sync };
  });
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

  it("compares with the sync branch when the last push went there and was merged", async () => {
    given({ head: "remote", files: { "index.html": "<h1>v1</h1>" }, sync: { ...LINKED, syncBranchSha: "side", syncBranchAt: 2 } });
    mocks.compare.mockResolvedValue({ data: { status: "ahead" } });

    const res = await pull();

    expect(res.status).toBe(200);
    expect(mocks.compare).toHaveBeenCalledWith(expect.objectContaining({ basehead: "side...remote" }));
    expect(mocks.getCommit).toHaveBeenCalledWith(expect.objectContaining({ commit_sha: "side" }));
  });

  it("asks first when changes pushed to the sync branch aren't on the linked branch yet", async () => {
    given({ head: "remote", files: { "index.html": "<h1>v1</h1>" }, sync: { ...LINKED, syncBranchSha: "side", syncBranchAt: 2 } });
    mocks.compare.mockResolvedValue({ data: { status: "diverged" } });

    const res = await pull();

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: GITHUB_SYNC_CONFLICT, unmerged: true });
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("refuses while an agent run is in progress, before asking GitHub", async () => {
    given({ head: "remote", files: {}, running: true });

    const res = await pull({ overwrite: true });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "Stop the running agent before pulling" });
    expect(mocks.getRef).not.toHaveBeenCalled();
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing repo or branch", githubError(404), 404, /Couldn't read octocat\/widgets \(main\)/],
    ["lost access", githubError(403), 403, /lost access/],
    ["the rate limit", githubError(403, { "x-ratelimit-remaining": "0" }), 429, /rate limit/],
  ])("explains GitHub errors as JSON: %s", async (_, error, status, message) => {
    given({ head: "remote", files: {} });
    mocks.getRef.mockRejectedValue(error);

    const res = await pull();

    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(message) });
  });

  it("asks to reconnect GitHub when it rejects the token", async () => {
    given({ head: "remote", files: {} });
    mocks.getRef.mockRejectedValue(githubError(401));

    const res = await pull();

    expect(await res.json()).toMatchObject({ code: GITHUB_NOT_LINKED });
  });

  it("refuses a project that was never exported", async () => {
    mocks.query.mockResolvedValue({ _id: "p1", ownerId: "user_1" });

    const res = await pull();

    expect(res.status).toBe(400);
    expect(mocks.getRef).not.toHaveBeenCalled();
  });
});
