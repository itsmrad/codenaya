import { gzipSync } from "node:zlib";
import { Header } from "tar";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ mutation: vi.fn() }));

vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: async () => ({
    users: { getUserOauthAccessToken: async () => ({ data: [{ token: "gho_test" }] }) },
  }),
}));
vi.mock("@/lib/convex-client", () => ({
  convex: {
    // getOwnedProject and getProjectById: the user's linked project.
    query: vi.fn(async () => ({
      _id: "p1",
      ownerId: "user_1",
      githubSync: { repo: "octocat/widgets", branch: "main", lastSyncedSha: "old", lastSyncedAt: 1 },
    })),
    mutation: mocks.mutation,
  },
}));
// Expose the job handler directly; steps run inline.
vi.mock("@/inngest/client", () => ({
  inngest: { createFunction: (_config: unknown, handler: unknown) => handler },
}));

import { pullFromGithub } from "./pull-from-github";

// A gzipped tarball shaped like GitHub's: everything under "<owner>-<repo>-<sha>/".
function tarball(entries: { path: string; body?: string; type?: "File" | "Directory" }[]) {
  const blocks = entries.flatMap(({ path, body = "", type = "File" }) => {
    const data = Buffer.from(body);
    const header = new Header({
      path: `octocat-widgets-abc1234/${path}`,
      type,
      size: data.length,
      mode: 0o644,
      mtime: new Date(0),
    });
    header.encode();
    const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
    data.copy(padded);
    return [header.block!, padded];
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

const fetchMock = vi.fn();

const runJob = () =>
  (pullFromGithub as unknown as (ctx: unknown) => Promise<unknown>)({
    event: { data: { projectId: "p1", userId: "user_1", sha: "abc1234def" } },
    step: { run: (_name: string, fn: () => unknown) => fn() },
  });

/** Each Convex mutation the job ran, by name, with its arguments. */
const calls = () =>
  mocks.mutation.mock.calls.map(([fn, args]) => [getFunctionName(fn).replace("system:", ""), args]);

describe("pullFromGithub (#343)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation(
      async () =>
        new Response(
          tarball([
            { path: "", type: "Directory" },
            { path: "src/", type: "Directory" },
            { path: "src/app.ts", body: "export {};" },
            { path: "index.html", body: "<h1>from GitHub</h1>" },
          ])
        )
    );
  });

  it("checkpoints before writing, then applies the pinned commit's tree and moves the sync point", async () => {
    await expect(runJob()).resolves.toMatchObject({ success: true, sha: "abc1234def" });

    // The commit the user saw, not whatever the branch points at now.
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/octocat/widgets/tarball/abc1234def"
    );
    expect(calls().map(([name]) => name)).toEqual([
      "updateExportStatus",
      "createPullCheckpoint",
      "applyPulledFiles",
      "finishPull",
      "updateExportStatus",
    ]);
    const [, [, checkpoint], [, apply], [, finish]] = calls();
    expect(checkpoint).toMatchObject({ label: "Before pull from GitHub @ abc1234" });
    // Folders first, so every file's parent exists when its batch lands.
    expect(apply.entries).toEqual([
      { path: "src", type: "folder" },
      { path: "src/app.ts", type: "file", content: "export {};" },
      { path: "index.html", type: "file", content: "<h1>from GitHub</h1>" },
    ]);
    expect(finish).toMatchObject({
      sha: "abc1234def",
      tree: expect.arrayContaining([
        { path: "src", type: "folder" },
        { path: "src/app.ts", type: "file" },
        { path: "index.html", type: "file" },
      ]),
    });
  });
});
