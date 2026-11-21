// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { gzipSync } from "node:zlib";
import { Header } from "tar";
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";

import { api } from "../../../../convex/_generated/api";
import schema from "../../../../convex/schema";
import type { Id } from "../../../../convex/_generated/dataModel";
import { withContents } from "../../../../convex/fileContents";
import { buildPathIndex } from "@/features/conversations/agent-steps";
import { planSeedTree } from "@/features/templates/seed-files";

const mocks = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn(), github: {} as Record<string, ReturnType<typeof vi.fn>> }));
vi.mock("@/lib/convex-client", () => ({ convex: { query: mocks.query, mutation: mocks.mutation } }));
vi.mock("@/features/projects/server/github-token", () => ({ requireJobGithubToken: async () => "dummy-github-token", getJobGithubToken: async () => "dummy-github-token" }));
vi.mock("@/features/security/server/scan-stored-project", () => ({ storedScanEnv: async () => [] }));
vi.mock("@/inngest/client", () => ({ inngest: { createFunction: (_config: unknown, handler: unknown) => handler } }));
vi.mock("octokit", () => ({ Octokit: class { rest = { git: mocks.github }; }, RequestError: class extends Error {} }));

import { Octokit } from "octokit";
import { currentFiles, gitBlobSha, pushToGithub } from "./push-to-github";
import { differsFromCommit, pullFromGithub } from "./pull-from-github";

const modules = import.meta.glob("../../../../convex/**/*.ts");
const internalKey = "dummy-roundtrip-key";
const privatePaths = [".npmrc", ".env.local", "keys/server.pem", "dist/runtime.js", "src/node_modules/dep.js"];
const sourcePaths = ["index.html", "src/app/build/page.tsx", "src/app/settings/credentials/page.tsx", "scripts/build"];

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

/** A real archive exercises pull's filtering before it decodes any private body. */
function archive(files: Map<string, string>) {
  const blocks = [...files].flatMap(([path, content]) => {
    const bytes = Buffer.from(content);
    const header = new Header({ path: `owner-repo-sha/${path}`, type: "File", size: bytes.length, mode: 0o644 });
    header.encode();
    const padded = Buffer.alloc(Math.ceil(bytes.length / 512) * 512);
    bytes.copy(padded);
    return [header.block!, padded];
  });
  const directories = planSeedTree([...files].map(([path, content]) => ({ path, content }))).folders.map(path => {
    const header = new Header({ path: `owner-repo-sha/${path}/`, type: "Directory", size: 0, mode: 0o755 });
    header.encode();
    return header.block!;
  });
  return gzipSync(Buffer.concat([...directories, ...blocks, Buffer.alloc(1024)]));
}

test("push then pull preserves local private canaries and never changes their remote copies", async () => {
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", internalKey);
  const t = convexTest(schema, modules);
  mocks.query.mockImplementation(t.query);
  mocks.mutation.mockImplementation(t.mutation);
  const local = Object.fromEntries([
    ...sourcePaths.map(path => [path, `source ${path}`] as const),
    ...privatePaths.map(path => [path, `LOCAL_CANARY_123 ${path}`] as const),
  ]);
  const projectId = await t.run(async ctx => {
    const id = await ctx.db.insert("projects", { name: "Round trip", ownerId: "owner", updatedAt: 0,
      githubSync: { repo: "owner/repo", branch: "main", lastSyncedSha: "old", lastSyncedAt: 0 } });
    const { folders, filesByFolder } = planSeedTree(Object.entries(local).map(([path, content]) => ({ path, content })));
    const ids = new Map<string, Id<"files">>();
    for (const path of folders) {
      const slash = path.lastIndexOf("/");
      ids.set(path, await ctx.db.insert("files", { projectId: id, name: path.slice(slash + 1), type: "folder", updatedAt: 0,
        parentId: slash < 0 ? undefined : ids.get(path.slice(0, slash)) }));
    }
    for (const [folder, files] of filesByFolder) for (const file of files) await ctx.db.insert("files", {
      projectId: id, name: file.name, parentId: ids.get(folder), type: "file", content: file.content, updatedAt: 0,
    });
    return id;
  });

  const remote = new Map<string, string>([
    ...sourcePaths.map(path => [path, `old ${path}`] as const),
    ...privatePaths.map(path => [path, `REMOTE_CANARY_456 ${path}`] as const),
  ]);
  let head = "old";
  mocks.github = {
    getRef: vi.fn(async () => ({ data: { object: { sha: head } } })),
    getCommit: vi.fn(async () => ({ data: { tree: { sha: "tree" } } })),
    getTree: vi.fn(async () => ({ data: { tree: [...remote].map(([path, content]) => ({ path, type: "blob", sha: gitBlobSha(Buffer.from(content)) })) } })),
    createTree: vi.fn(async ({ tree }: { tree: { path: string; content?: string; sha?: null }[] }) => {
      for (const entry of tree) {
        if (entry.sha === null) remote.delete(entry.path);
        else if (entry.content !== undefined) remote.set(entry.path, entry.content);
      }
      return { data: { sha: "new-tree" } };
    }),
    createCommit: vi.fn(async () => ({ data: { sha: "pushed" } })),
    updateRef: vi.fn(async ({ sha }: { sha: string }) => { head = sha; }),
  };
  const step = { run: (_name: string, fn: () => unknown) => fn() };
  const event = { data: { projectId, userId: "owner", sha: "pushed" } };
  await (pushToGithub as unknown as (args: unknown) => Promise<unknown>)({ event, step });
  expect(head).toBe("pushed");
  for (const path of privatePaths) expect(remote.get(path)).toBe(`REMOTE_CANARY_456 ${path}`);
  for (const path of sourcePaths) expect(remote.get(path)).toBe(local[path]);
  expect(JSON.stringify(mocks.github.createTree.mock.calls)).not.toMatch(/LOCAL_CANARY|REMOTE_CANARY/);
  expect(mocks.github.createTree.mock.calls[0][0].tree.map((entry: { path: string }) => entry.path).sort()).toEqual([...sourcePaths].sort());
  // Private paths are absent from the comparison on both sides.
  expect(await differsFromCommit(new Octokit(), "owner", "repo", head, await currentFiles(internalKey, projectId))).toBe(false);

  const fetchMock = vi.fn(async () => new Response(archive(remote)));
  vi.stubGlobal("fetch", fetchMock);
  mocks.mutation.mockClear();
  await (pullFromGithub as unknown as (args: unknown) => Promise<unknown>)({ event, step });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const restored = await t.run(async ctx => {
    const files = await withContents(ctx, projectId, await ctx.db.query("files").withIndex("by_project", q => q.eq("projectId", projectId)).take(100));
    const pathOf = buildPathIndex(files);
    return Object.fromEntries(files.filter(file => file.type === "file").map(file => [pathOf(file._id) ?? file.name, file.content ?? null]));
  });
  for (const path of privatePaths) {
    expect(restored[path]).toBe(local[path]);
    expect(remote.get(path)).toBe(`REMOTE_CANARY_456 ${path}`);
  }
  for (const path of sourcePaths) expect(restored[path]).toBe(local[path]);
  expect(JSON.stringify(mocks.mutation.mock.calls)).not.toMatch(/LOCAL_CANARY|REMOTE_CANARY/);
});
