import { gzipSync } from "node:zlib";
import { Header } from "tar";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
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
type Entry = { path: string; body?: string | Buffer; type?: "File" | "Directory" | "SymbolicLink" };

function tarball(entries: Entry[]) {
  const blocks = entries.flatMap(({ path, body = "", type = "File" }) => {
    const data = type === "SymbolicLink" ? Buffer.alloc(0) : Buffer.from(body);
    const header = new Header({
      path: `octocat-widgets-abc1234/${path}`,
      type,
      linkpath: type === "SymbolicLink" ? "elsewhere" : undefined,
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
  mocks.mutation.mock.calls.map(([fn, args]) => [getFunctionName(fn).split(":").pop(), args]);

/** GitHub answers the archive request with these entries; uploads get a blob id. */
function serve(entries: Entry[]) {
  fetchMock.mockImplementation(async (input: string | URL | Request) =>
    String(input instanceof Request ? input.url : input).startsWith("https://upload.test")
      ? Response.json({ storageId: "blob_1" })
      : new Response(tarball([{ path: "", type: "Directory" }, ...entries]))
  );
}

const written = () => calls().filter(([name]) => name === "applyPulledFiles" || name === "finishPull");

describe("pullFromGithub (#343)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
    vi.stubGlobal("fetch", fetchMock);
    mocks.mutation.mockImplementation(async (fn) =>
      getFunctionName(fn).endsWith("generateUploadUrl") ? "https://upload.test/1" : null
    );
    serve([
      { path: "src/", type: "Directory" },
      { path: "src/app.ts", body: "export {};" },
      { path: "index.html", body: "<h1>from GitHub</h1>" },
    ]);
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
      "applyPulledFiles",
      "finishPull",
      "updateExportStatus",
    ]);
    const [, [, checkpoint], [, prune], [, apply], [, finish]] = calls();
    expect(checkpoint).toMatchObject({ label: "Before pull from GitHub @ abc1234" });
    // Paths GitHub no longer has go before anything is written.
    expect(prune).toMatchObject({
      entries: [],
      tree: [
        { path: "src", type: "folder" },
        { path: "src/app.ts", type: "file" },
        { path: "index.html", type: "file" },
      ],
    });
    // Folders first, so every file's parent exists when its batch lands.
    expect(apply.entries).toEqual([
      { path: "src", type: "folder" },
      { path: "src/app.ts", type: "file", content: "export {};" },
      { path: "index.html", type: "file", content: "<h1>from GitHub</h1>" },
    ]);
    expect(finish).toMatchObject({ sha: "abc1234def" });
  });

  it("uploads binaries and sends them by blob id", async () => {
    serve([{ path: "logo.png", body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]) }]);

    await runJob();

    const upload = fetchMock.mock.calls.find(([input]) => String(input instanceof Request ? input.url : input).startsWith("https://upload.test"));
    expect(upload).toBeDefined();
    // applyTree keeps the old blob when the bytes match (convex/githubPull.test.ts).
    expect(written()[1][1].entries).toEqual([{ path: "logo.png", type: "file", storageId: "blob_1" }]);
  });

  it("refuses a repo over the checkpoint cap before writing anything", async () => {
    serve(Array.from({ length: 2001 }, (_, i) => ({ path: `f${i}.ts`, body: "" })));

    await expect(runJob()).rejects.toMatchObject({
      name: "NonRetriableError",
      message: expect.stringMatching(/over 2000 files/),
    });
    expect(written()).toEqual([]);
  });

  it("refuses, naming them, when files can't be pulled, so the next push can't delete them on GitHub", async () => {
    serve([
      ...Array.from({ length: 6 }, (_, i) => ({ path: `link${i}`, type: "SymbolicLink" as const })),
      { path: "big.json", body: "a".repeat(900 * 1024 + 1) },
      { path: "ok.ts", body: "export {};" },
    ]);

    await expect(runJob()).rejects.toMatchObject({
      name: "NonRetriableError",
      message: expect.stringMatching(/link0, link1, link2, link3, link4 and 2 more$/),
    });
    expect(written()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops for good when an agent starts mid-pull, instead of retrying over its run", async () => {
    mocks.mutation.mockImplementation(async (fn, args) => {
      if (getFunctionName(fn).endsWith("applyPulledFiles") && args.entries.length > 0) {
        throw new ConvexError({ code: "CONFLICT", message: "Stop the running agent before pulling" });
      }
      return null;
    });

    await expect(runJob()).rejects.toMatchObject({
      name: "NonRetriableError",
      message: "Stop the running agent before pulling",
    });
    expect(calls().map(([name]) => name)).not.toContain("finishPull");
  });

  it("leaves other failures to Inngest's retries", async () => {
    mocks.mutation.mockImplementation(async (fn) => {
      if (getFunctionName(fn).endsWith("finishPull")) throw new Error("network down");
      return null;
    });

    await expect(runJob()).rejects.toMatchObject({ name: "Error", message: "network down" });
  });
});
