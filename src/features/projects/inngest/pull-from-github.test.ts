import { gzipSync } from "node:zlib";
import { Header } from "tar";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ mutation: vi.fn(), files: vi.fn() }));

vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: async () => ({
    users: { getUserOauthAccessToken: async () => ({ data: [{ token: "gho_test" }] }) },
  }),
}));
vi.mock("@/lib/convex-client", () => ({
  convex: {
    // getOwnedProject and getProjectById: the user's linked project.
    query: vi.fn(async (fn) => getFunctionName(fn).endsWith(":getProjectFiles") ? mocks.files() : ({
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

/** One attempt of the job. Steps in `done` return their saved result, as on an Inngest retry. */
const runJob = (done = new Map<string, unknown>()) =>
  (pullFromGithub as unknown as (ctx: unknown) => Promise<unknown>)({
    event: { data: { projectId: "p1", userId: "user_1", sha: "abc1234def" } },
    step: {
      run: async (name: string, fn: () => unknown) => {
        if (!done.has(name)) done.set(name, await fn());
        return done.get(name);
      },
    },
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
    mocks.files.mockReturnValue([]);
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
    vi.stubGlobal("fetch", fetchMock);
    mocks.mutation.mockImplementation(async (fn) => {
      const name = getFunctionName(fn);
      if (name.endsWith("generateUploadUrl")) return "https://upload.test/1";
      if (name.endsWith("createPullCheckpoint")) return "cp_1";
      return null;
    });
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
    expect(finish).toMatchObject({ sha: "abc1234def", checkpointId: "cp_1" });
    // Every write names the checkpoint, so Convex can refuse once a run came after it.
    expect(written().every(([, args]) => args.checkpointId === "cp_1")).toBe(true);
  });

  it("skips real dotenv bodies while pulling example files and ordinary files (#812)", async () => {
    serve([
      { path: ".env", body: "PRIVATE_KEY=fake-remote-secret" },
      { path: ".env.local", body: "LOCAL_KEY=fake-remote-local" },
      { path: ".env.production", body: "PROD_KEY=fake-remote-production" },
      { path: ".env.template", body: "TEMPLATE_KEY=fake-remote-template" },
      { path: ".env.example", body: "EXAMPLE_KEY=fake-example" },
      { path: ".env.sample", body: "SAMPLE_KEY=fake-sample" },
      { path: "app.ts", body: "export {};" },
    ]);

    await expect(runJob()).resolves.toMatchObject({ success: true });

    expect(written()[1][1].entries).toEqual([
      { path: ".env.example", type: "file", content: "EXAMPLE_KEY=fake-example" },
      { path: ".env.sample", type: "file", content: "SAMPLE_KEY=fake-sample" },
      { path: "app.ts", type: "file", content: "export {};" },
    ]);
    expect(written()[0][1].tree).toEqual([
      { path: ".env.example", type: "file" },
      { path: ".env.sample", type: "file" },
      { path: "app.ts", type: "file" },
    ]);
    expect(JSON.stringify(calls())).not.toContain("fake-remote-");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("keeps every local dotenv file unchanged (remote dotenv present: %s) (#812)", async (remoteEnv) => {
    const local = new Map([
      [".env", "PRIVATE_KEY=fake-local-secret"],
      [".env.local", "LOCAL_KEY=fake-local-value"],
      ["apps", ""],
      ["apps/web", ""],
      ["apps/web/.env", "NESTED_KEY=fake-local-nested"],
      ["apps/web/.env.local", "NESTED_LOCAL_KEY=fake-local-nested-local"],
      ["old.ts", "old"],
      [".env.example", "obsolete example"],
      [".env.sample", "obsolete sample"],
    ]);
    // The existing metadata-only query: no local dotenv bodies are fetched.
    mocks.files.mockReturnValue([...local.keys()].map((path) => {
      const slash = path.lastIndexOf("/");
      return {
        _id: path,
        name: path.slice(slash + 1),
        parentId: slash < 0 ? undefined : path.slice(0, slash),
        type: path === "apps" || path === "apps/web" ? "folder" : "file",
      };
    }));
    serve([
      ...(remoteEnv ? [
        { path: ".env", body: "PRIVATE_KEY=fake-remote-secret" },
        { path: ".env.local", body: "LOCAL_KEY=fake-remote-local" },
      ] : []),
      { path: "app.ts", body: "export {};" },
    ]);
    mocks.mutation.mockImplementation(async (fn, args) => {
      const name = getFunctionName(fn);
      if (name.endsWith("createPullCheckpoint")) return "cp_1";
      if (name.endsWith("applyPulledFiles")) {
        // Model applyTree: missing paths and descendants of removed folders are deleted.
        if (args.tree) {
          const keep = new Set(args.tree.map((entry: { path: string }) => entry.path));
          const removed = [...local.keys()].filter((path) => !keep.has(path));
          for (const path of local.keys()) {
            if (removed.some((parent) => path === parent || path.startsWith(`${parent}/`))) local.delete(path);
          }
        }
        for (const entry of args.entries) local.set(entry.path, entry.content);
      }
      return null;
    });

    await runJob();

    expect([...local]).toEqual([
      [".env", "PRIVATE_KEY=fake-local-secret"],
      [".env.local", "LOCAL_KEY=fake-local-value"],
      ["apps", ""],
      ["apps/web", ""],
      ["apps/web/.env", "NESTED_KEY=fake-local-nested"],
      ["apps/web/.env.local", "NESTED_LOCAL_KEY=fake-local-nested-local"],
      ["app.ts", "export {};"],
    ]);
    expect(JSON.stringify(calls())).not.toContain("fake-remote-");
    expect(JSON.stringify(calls())).not.toContain("fake-local-");
  });

  it("explains that preserved local private entries count toward the pull cap", async () => {
    mocks.files.mockReturnValue(Array.from({ length: 2001 }, (_, i) => ({ _id: `env-${i}`, name: `.env.${i}`, type: "file" })));
    await expect(runJob()).rejects.toMatchObject({
      name: "NonRetriableError",
      message: expect.stringMatching(/including preserved local private entries.*project or repository/),
    });
    expect(written()).toEqual([]);
  });

  it("refuses a remote file that would replace a local dotenv parent folder (#812)", async () => {
    mocks.files.mockReturnValue([
      { _id: "apps", name: "apps", type: "folder" },
      { _id: "env", name: ".env", type: "file", parentId: "apps" },
    ]);
    serve([{ path: "apps", body: "remote file" }]);

    await expect(runJob()).rejects.toMatchObject({
      name: "NonRetriableError",
      message: expect.stringMatching(/local private/),
    });
    expect(written()).toEqual([]);
  });

  it("refuses for good on a retry when a run finished during the backoff", async () => {
    const changed = new ConvexError({
      code: "CONFLICT",
      message: 'The project changed during the pull. Restore the "Before pull" checkpoint from the history if needed, then pull again.',
    });
    let attempt = 0;
    mocks.mutation.mockImplementation(async (fn) => {
      const name = getFunctionName(fn);
      if (name.endsWith("createPullCheckpoint")) return "cp_1";
      if (name.endsWith("applyPulledFiles")) {
        attempt += 1;
        // First attempt: a transient failure. By the retry, a run has finished.
        if (attempt === 1) throw new Error("Convex is unavailable");
        throw changed;
      }
      return null;
    });
    const done = new Map<string, unknown>();

    await expect(runJob(done)).rejects.toMatchObject({ name: "Error" });
    await expect(runJob(done)).rejects.toMatchObject({
      name: "NonRetriableError",
      message: expect.stringMatching(/changed during the pull\. Restore the "Before pull" checkpoint/),
    });
    // The checkpoint is the first attempt's, never retaken over a half-pulled tree.
    expect(calls().filter(([name]) => name === "createPullCheckpoint")).toHaveLength(1);
    expect(calls().map(([name]) => name)).not.toContain("finishPull");
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
      message: expect.stringMatching(/would exceed 2000 files and folders, including preserved local private entries/),
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
