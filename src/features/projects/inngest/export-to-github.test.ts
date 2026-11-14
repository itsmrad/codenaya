import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mutation: vi.fn(),
  query: vi.fn(),
  kyGet: vi.fn(),
  createBlob: vi.fn(),
  createTree: vi.fn(),
  createCommit: vi.fn(),
  updateRef: vi.fn(),
}));

vi.mock("@/lib/convex-client", () => ({
  convex: { query: mocks.query, mutation: mocks.mutation },
}));
vi.mock("@/features/projects/server/github-token", () => ({
  requireJobGithubToken: async () => "gho_test",
}));
vi.mock("ky", () => ({ default: { get: mocks.kyGet } }));
vi.mock("octokit", () => ({
  Octokit: class {
    rest = {
      users: { getAuthenticated: async () => ({ data: { login: "octocat" } }) },
      repos: {
        createForAuthenticatedUser: async () => ({
          data: { html_url: "https://github.com/octocat/demo", full_name: "octocat/demo" },
        }),
      },
      git: {
        getRef: async () => ({ data: { object: { sha: "init" } } }),
        createBlob: mocks.createBlob,
        createTree: mocks.createTree,
        createCommit: mocks.createCommit,
        updateRef: mocks.updateRef,
      },
    };
  },
}));
// Expose the job handler directly, with its config for `onFailure`; steps run inline.
vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (config: unknown, handler: object) => Object.assign(handler, { config }),
  },
}));

import { exportToGithub } from "./export-to-github";

type ProjectFile = {
  _id: string;
  name: string;
  type: "file" | "folder";
  parentId?: string;
  content?: string;
  storageUrl?: string | null;
  updatedAt?: number;
};

const runJob = () =>
  (exportToGithub as unknown as (ctx: unknown) => Promise<unknown>)({
    event: {
      data: { projectId: "p1", repoName: "demo", visibility: "private", userId: "user_1" },
    },
    step: { run: (_name: string, fn: () => unknown) => fn(), sleep: async () => {} },
  });

const projectFiles = (files: ProjectFile[]) =>
  mocks.query.mockResolvedValue(files.map((file) => ({ updatedAt: 100, ...file })));

describe("exportToGithub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
    mocks.createBlob.mockImplementation(async ({ content }) => ({ data: { sha: `sha:${content}` } }));
    mocks.createTree.mockResolvedValue({ data: { sha: "tree" } });
    mocks.createCommit.mockResolvedValue({ data: { sha: "commit" } });
  });

  it("commits text as UTF-8 and binary as base64 at their full paths", async () => {
    mocks.kyGet.mockResolvedValue({ arrayBuffer: async () => Uint8Array.from([0x89, 0x50, 0x00]).buffer });
    projectFiles([
      { _id: "src", name: "src", type: "folder" },
      { _id: "ui", name: "ui", type: "folder", parentId: "src" },
      { _id: "a", name: "README.md", type: "file", content: "# hi", updatedAt: 300 },
      { _id: "b", name: "button.tsx", type: "file", parentId: "ui", content: "", updatedAt: 700 },
      { _id: "c", name: "logo.png", type: "file", parentId: "src", storageUrl: "https://storage/logo" },
      { _id: "d", name: "lost.bin", type: "file", storageUrl: null },
    ]);

    await expect(runJob()).resolves.toEqual({
      success: true,
      repoUrl: "https://github.com/octocat/demo",
      filesExported: 3,
    });

    expect(mocks.kyGet).toHaveBeenCalledWith("https://storage/logo");
    expect(mocks.createBlob.mock.calls.map(([a]) => [a.content, a.encoding])).toEqual([
      ["# hi", "utf-8"],
      // An empty text file is still exported, not skipped as missing content.
      ["", "utf-8"],
      [Buffer.from([0x89, 0x50, 0x00]).toString("base64"), "base64"],
    ]);
    expect(mocks.createTree.mock.calls[0][0].tree.map((i: { path: string }) => i.path)).toEqual([
      "README.md",
      "src/ui/button.tsx",
      "src/logo.png",
    ]);
    expect(mocks.createCommit.mock.calls[0][0]).toMatchObject({ tree: "tree", parents: ["init"] });
    expect(mocks.updateRef.mock.calls[0][0]).toMatchObject({ ref: "heads/main", sha: "commit" });
    // Fast-forward over the auto_init commit, never forced (#343).
    expect(mocks.updateRef.mock.calls[0][0]).not.toHaveProperty("force");
    // Later changes are pushed to this repo.
    const linked = mocks.mutation.mock.calls.find(([ref]) => getFunctionName(ref) === "system:setGithubSync");
    expect(linked?.[1].githubSync).toEqual({
      repo: "octocat/demo",
      branch: "main",
      lastSyncedSha: "commit",
      // The newest file write, on Convex's clock like the runs it is compared with.
      lastSyncedAt: 700,
    });

    const statuses = mocks.mutation.mock.calls
      .filter(([ref]) => getFunctionName(ref) === "system:updateExportStatus")
      .map(([, args]) => args.status);
    expect(statuses).toEqual(["exporting", "completed"]);
  });

  it("refuses a project with no files", async () => {
    projectFiles([{ _id: "src", name: "src", type: "folder" }]);

    await expect(runJob()).rejects.toThrow("No files to export");
    expect(mocks.createBlob).not.toHaveBeenCalled();
  });

  it("refuses when no file has content to commit", async () => {
    projectFiles([{ _id: "d", name: "lost.bin", type: "file", storageUrl: null }]);

    await expect(runJob()).rejects.toThrow("Failed to create any file blobs");
    expect(mocks.createTree).not.toHaveBeenCalled();
  });
});

describe("exportToGithub onFailure", () => {
  it("marks the export failed", async () => {
    vi.clearAllMocks();
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
    const { onFailure } = (exportToGithub as unknown as { config: { onFailure: (ctx: unknown) => Promise<void> } }).config;

    await onFailure({
      event: { data: { event: { data: { projectId: "p1" } } } },
      step: { run: (_name: string, fn: () => unknown) => fn() },
    });

    const [[ref, args]] = mocks.mutation.mock.calls;
    expect(getFunctionName(ref)).toBe("system:updateExportStatus");
    expect(args).toEqual({ internalKey: "test-key", projectId: "p1", status: "failed" });
  });
});
