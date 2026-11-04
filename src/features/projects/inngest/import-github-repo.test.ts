import { gzipSync } from "node:zlib";
import { Header } from "tar";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserOauthAccessToken: vi.fn(),
  mutation: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: async () => ({
    users: { getUserOauthAccessToken: mocks.getUserOauthAccessToken },
  }),
}));
vi.mock("@/lib/convex-client", () => ({
  convex: {
    // getOwnedProject: the user owns the project.
    query: vi.fn(async () => ({ _id: "p1", ownerId: "user_1" })),
    mutation: mocks.mutation,
  },
}));
// Expose the job handler directly; steps run inline.
vi.mock("@/inngest/client", () => ({
  inngest: { createFunction: (_config: unknown, handler: unknown) => handler },
}));

import { importGithubRepo } from "./import-github-repo";
import { MAX_IMPORT_BYTES } from "../server/github-archive";

type Entry = { path: string; body?: string; type?: "File" | "Directory"; size?: number };

// A gzipped tarball shaped like GitHub's: everything under "<owner>-<repo>-<sha>/".
// `size` overrides the header size, to claim a big file without writing one.
function tarball(entries: Entry[]) {
  const blocks = entries.flatMap(({ path, body = "", type = "File", size }) => {
    const data = Buffer.from(body);
    const header = new Header({
      path: path.startsWith("../") ? path : `octocat-Hello-World-abc123/${path}`,
      type,
      size: size ?? data.length,
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
  (importGithubRepo as unknown as (ctx: unknown) => Promise<unknown>)({
    event: {
      data: { owner: "octocat", repo: "Hello-World", projectId: "p1", userId: "user_1" },
    },
    step: { run: (_name: string, fn: () => unknown) => fn() },
  });

// Flattens `createFiles` batches so each file reads like a single create.
const created = (name: string) =>
  mocks.mutation.mock.calls
    .flatMap(([fn, args]) =>
      args.files ? args.files.map((file: object) => [fn, { ...args, ...file }]) : [[fn, args]]
    )
    .filter(([, args]) => args.name === name);

const batches = () => mocks.mutation.mock.calls.filter(([, args]) => args.files).map(([, args]) => args);

describe("importGithubRepo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
    vi.stubGlobal("fetch", fetchMock);
    mocks.getUserOauthAccessToken.mockResolvedValue({ data: [] });
    // File writes return an id; `system.cleanup` (no name) reports it is done.
    mocks.mutation.mockImplementation(async (_fn, args) =>
      args.name ? `id:${args.name}` : { deleted: 0, done: true }
    );
    fetchMock.mockImplementation(
      async () =>
        new Response(
          tarball([
            { path: "", type: "Directory" },
            { path: "src/", type: "Directory" },
            { path: "README.md", body: "# hi" },
            { path: "src/index.ts", body: "export {};" },
          ])
        )
    );
  });

  it("imports a public repo from one unauthenticated archive request (#364)", async () => {
    await expect(runJob()).resolves.toMatchObject({ success: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/octocat/Hello-World/tarball");
    expect(init.headers).not.toHaveProperty("Authorization");
    expect(created("src")[0][1]).toMatchObject({ parentId: undefined });
    expect(created("README.md")[0][1]).toMatchObject({ content: "# hi", parentId: undefined });
    expect(created("index.ts")[0][1]).toMatchObject({ content: "export {};", parentId: "id:src" });
  });

  it("creates a parent folder before a child listed ahead of it", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        tarball([
          { path: "src/ui/", type: "Directory" },
          { path: "src/", type: "Directory" },
          { path: "src/ui/button.ts", body: "export {};" },
        ])
      )
    );

    await runJob();

    expect(created("src")[0][1]).toMatchObject({ parentId: undefined });
    expect(created("ui")[0][1]).toMatchObject({ parentId: "id:src" });
    expect(created("button.ts")[0][1]).toMatchObject({ parentId: "id:ui" });
  });

  it("writes a folder's text files in one createFiles call (#411)", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        tarball([
          { path: "src/", type: "Directory" },
          { path: "src/a.ts", body: "a" },
          { path: "src/b.ts", body: "b" },
        ])
      )
    );

    await runJob();

    expect(batches()).toEqual([
      expect.objectContaining({
        parentId: "id:src",
        files: [
          { name: "a.ts", content: "a" },
          { name: "b.ts", content: "b" },
        ],
      }),
    ]);
  });

  it.each([
    { cap: "file count", count: 101, size: 1 },
    { cap: "bytes", count: 5, size: 850 * 1024 },
  ])("splits a folder's batch at the $cap cap", async ({ count, size }) => {
    const files = Array.from({ length: count }, (_, i) => ({ path: `f${i}`, body: "x".repeat(size) }));
    fetchMock.mockResolvedValue(new Response(tarball(files)));

    await runJob();

    expect(batches().map((batch) => batch.files.length)).toEqual([count - 1, 1]);
  });

  it("skips a text file over the document size cap and imports the rest", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        tarball([
          { path: "big.json", body: "x".repeat(901 * 1024) },
          { path: "README.md", body: "# hi" },
        ])
      )
    );

    await expect(runJob()).resolves.toMatchObject({ success: true });

    expect(created("big.json")).toHaveLength(0);
    expect(created("README.md")).toHaveLength(1);
  });

  it("fails the step when a batch write fails, so the retry re-imports from clean", async () => {
    mocks.mutation.mockImplementation(async (_fn, args) => {
      if (args.files) throw new Error("transient");
      return args.name ? `id:${args.name}` : { deleted: 0, done: true };
    });

    await expect(runJob()).rejects.toThrow("transient");
  });

  it("uploads a binary file to storage instead of writing it as text", async () => {
    // ky posts a Request object; the archive download passes a URL string.
    fetchMock.mockImplementation(async (input: string | Request) =>
      input instanceof Request
        ? Response.json({ storageId: "storage_1" })
        : new Response(tarball([{ path: "logo.png", body: "\x89PNG\x00\x00\x01" }]))
    );
    mocks.mutation.mockImplementation(async (_fn, args) =>
      args.name ? `id:${args.name}` : args.projectId ? { deleted: 0, done: true } : "https://upload.example/"
    );

    await runJob();

    expect(created("logo.png")[0][1]).toMatchObject({ storageId: "storage_1" });
    expect(created("logo.png")[0][1]).not.toHaveProperty("content");
  });

  it("clears the previous import in batches before writing", async () => {
    mocks.mutation
      .mockResolvedValueOnce({ deleted: 100, done: false })
      .mockResolvedValueOnce({ deleted: 3, done: true });

    await runJob();

    const firstWrite = mocks.mutation.mock.calls.findIndex(([, args]) => args.name);
    expect(firstWrite).toBe(2);
  });

  it("uses the linked account's token", async () => {
    mocks.getUserOauthAccessToken.mockResolvedValue({ data: [{ token: "gho_test" }] });

    await runJob();

    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      Authorization: "Bearer gho_test",
    });
  });

  it("rejects a repo over the size cap before reading it", async () => {
    fetchMock.mockResolvedValue(
      new Response(tarball([{ path: "huge.bin", size: MAX_IMPORT_BYTES + 1 }]))
    );

    await expect(runJob()).rejects.toThrow("can't be imported");
    expect(created("huge.bin")).toHaveLength(0);
  });

  it("rejects a repo over the file count cap", async () => {
    const files = Array.from({ length: 5001 }, (_, i) => ({ path: `f${i}`, body: "x" }));
    fetchMock.mockResolvedValue(new Response(tarball(files)));

    await expect(runJob()).rejects.toThrow("can't be imported");
    expect(created("f0")).toHaveLength(0);
    // Parsing 5000 entries takes a few seconds under the full parallel suite.
  }, 30_000);

  it("rejects path traversal entries", async () => {
    fetchMock.mockResolvedValue(
      new Response(tarball([{ path: "../passwd", body: "root" }]))
    );

    await expect(runJob()).rejects.toThrow(
      expect.objectContaining({ name: "NonRetriableError", message: expect.stringMatching("Unsafe path") })
    );
    expect(created("passwd")).toHaveLength(0);
  });

  it("fails cleanly when the archive can't be downloaded", async () => {
    fetchMock.mockResolvedValue(new Response("rate limited", { status: 403 }));

    await expect(runJob()).rejects.toThrow("GitHub archive download failed: 403");
  });
});
