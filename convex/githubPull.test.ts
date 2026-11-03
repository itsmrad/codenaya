// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { TreeEntry } from "./checkpoints";
import { withContents } from "./fileContents";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const INTERNAL_KEY = "test-internal-key";
const ALICE = "user_alice";

function setup() {
  const t = convexTest(schema, modules);
  return { t, alice: t.withIdentity({ subject: ALICE }) };
}

type T = ReturnType<typeof setup>["t"];

/** A linked project with `index.html`, `logo.png` and `src/{main,app}.ts`. */
async function seedProject(t: T) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const projectId = await ctx.db.insert("projects", {
      name: "App",
      ownerId: ALICE,
      updatedAt: now,
      githubSync: {
        repo: "octocat/widgets",
        branch: "main",
        lastSyncedSha: "old",
        lastSyncedAt: 1,
        syncBranchSha: "sync",
        syncBranchAt: 2,
      },
    });
    const conversationId = await ctx.db.insert("conversations", { projectId, title: "Chat", updatedAt: now });
    const logo = await ctx.storage.store(new Blob(["png-bytes"]));
    const file = (name: string, content: string, parentId?: Id<"files">) =>
      ctx.db.insert("files", { projectId, parentId, name, type: "file", content, updatedAt: now });
    await file("index.html", "<h1>v1</h1>");
    await ctx.db.insert("files", { projectId, name: "logo.png", type: "file", storageId: logo, updatedAt: now });
    const src = await ctx.db.insert("files", { projectId, name: "src", type: "folder", updatedAt: now });
    await file("main.ts", "console.log(1);", src);
    const app = await file("app.ts", "export {};", src);
    return { projectId, conversationId, logo, app };
  });
}

/** The project's files as `path → content or blob id`, folders as `path/`. */
const tree = (t: T, projectId: Id<"projects">) =>
  t.run(async (ctx) => {
    const files = await withContents(
      ctx,
      projectId,
      await ctx.db
        .query("files")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .collect(),
    );
    const byId = new Map(files.map((file) => [file._id, file]));
    const pathOf = (id: Id<"files">): string => {
      const file = byId.get(id)!;
      return file.parentId ? `${pathOf(file.parentId)}/${file.name}` : file.name;
    };
    return Object.fromEntries(
      files.map((file) =>
        file.type === "folder"
          ? [`${pathOf(file._id)}/`, null]
          : [pathOf(file._id), file.content ?? file.storageId ?? null],
      ),
    );
  });

/** What the pull job does with a remote tree: checkpoint, prune, batches, finish. */
const beforePull = (t: T, projectId: Id<"projects">) =>
  t.mutation(api.githubSync.createPullCheckpoint, {
    internalKey: INTERNAL_KEY,
    projectId,
    label: "Before pull from GitHub @ abc1234",
  });

async function pull(t: T, projectId: Id<"projects">, entries: TreeEntry[], batchSize = 2) {
  const checkpointId = await beforePull(t, projectId);
  await t.mutation(api.githubSync.applyPulledFiles, {
    internalKey: INTERNAL_KEY,
    projectId,
    checkpointId,
    entries: [],
    tree: entries.map(({ path, type }) => ({ path, type })),
  });
  for (let i = 0; i < entries.length; i += batchSize) {
    await t.mutation(api.githubSync.applyPulledFiles, {
      internalKey: INTERNAL_KEY,
      projectId,
      checkpointId,
      entries: entries.slice(i, i + batchSize),
    });
  }
  await t.mutation(api.githubSync.finishPull, {
    internalKey: INTERNAL_KEY,
    projectId,
    checkpointId,
    sha: "abc1234def",
  });
}

describe("GitHub pull (#343)", () => {
  beforeEach(() => {
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("applies the remote tree, and restoring the Before pull checkpoint gives back the exact pre-pull tree", async () => {
    const { t, alice } = setup();
    const { projectId, logo, app } = await seedProject(t);
    const before = await tree(t, projectId);
    // The job re-uploads every binary; an unchanged one keeps its old blob.
    const logoCopy = await t.run((ctx) => ctx.storage.store(new Blob(["png-bytes"])));

    await pull(t, projectId, [
      { path: "lib", type: "folder" },
      { path: "src", type: "folder" },
      { path: "index.html", type: "file", content: "<h1>from GitHub</h1>" },
      { path: "logo.png", type: "file", storageId: logoCopy },
      { path: "src/app.ts", type: "file", content: "export {};" },
      { path: "lib/util.ts", type: "file", content: "export const x = 1;" },
    ]);

    expect(await tree(t, projectId)).toEqual({
      "index.html": "<h1>from GitHub</h1>",
      "logo.png": logo,
      "src/": null,
      "src/app.ts": "export {};",
      "lib/": null,
      "lib/util.ts": "export const x = 1;",
    });
    await t.run(async (ctx) => {
      // Unchanged files keep their ids, so open tabs stay valid.
      expect(await ctx.db.get("files", app)).not.toBeNull();
      expect(await ctx.db.system.get("_storage", logoCopy)).toBeNull();
      // Later pushes build on the pulled commit, on the linked branch again.
      const sync = (await ctx.db.get("projects", projectId))?.githubSync;
      expect(sync).toMatchObject({ repo: "octocat/widgets", branch: "main", lastSyncedSha: "abc1234def" });
      expect(sync).not.toHaveProperty("syncBranchSha");
    });

    const [checkpoint] = await alice.query(api.checkpoints.list, { projectId });
    expect(checkpoint).toMatchObject({ label: "Before pull from GitHub @ abc1234", fileCount: 4 });
    expect(checkpoint.messageId).toBeUndefined();
    // No run, so no run diff.
    expect(await alice.query(api.checkpoints.listChanges, { checkpointId: checkpoint._id })).toEqual([]);

    await alice.mutation(api.checkpoints.restore, { checkpointId: checkpoint._id });
    expect(await tree(t, projectId)).toEqual(before);
  });

  test("a file replacing a folder takes the folder's contents with it", async () => {
    const { t } = setup();
    const { projectId } = await seedProject(t);

    await t.mutation(api.githubSync.applyPulledFiles, {
      internalKey: INTERNAL_KEY,
      projectId,
      checkpointId: await beforePull(t, projectId),
      entries: [{ path: "src", type: "file", content: "now a file" }],
    });

    expect(await tree(t, projectId)).toMatchObject({ src: "now a file" });
    expect(Object.keys(await tree(t, projectId)).filter((path) => path.startsWith("src/"))).toEqual([]);
  });

  test("refuses to pull over a running agent or without the internal key", async () => {
    const { t } = setup();
    const { projectId, conversationId } = await seedProject(t);

    await expect(
      t.mutation(api.githubSync.createPullCheckpoint, { internalKey: "wrong", projectId, label: "" }),
    ).rejects.toThrow();
    const checkpointId = await beforePull(t, projectId);
    await t.run((ctx) =>
      ctx.db.insert("messages", { projectId, conversationId, role: "assistant", content: "", status: "processing" }),
    );
    await expect(
      t.mutation(api.githubSync.createPullCheckpoint, { internalKey: INTERNAL_KEY, projectId, label: "" }),
    ).rejects.toThrow(/Stop the running agent/);
    // Typed, so the job can make it final instead of retrying over the run.
    await expect(
      t.mutation(api.githubSync.applyPulledFiles, { internalKey: INTERNAL_KEY, projectId, checkpointId, entries: [] }),
    ).rejects.toMatchObject({ data: { code: "CONFLICT", message: expect.stringMatching(/^The project changed during the pull\. Restore the "Before pull" checkpoint/) } });
    await expect(
      t.mutation(api.githubSync.finishPull, { internalKey: INTERNAL_KEY, projectId, checkpointId, sha: "abc" }),
    ).rejects.toThrow(/changed during the pull/);
    expect(await t.query(api.githubSync.isAgentRunning, { internalKey: INTERNAL_KEY, projectId })).toBe(true);
  });

  test("refuses to write once a run has finished since the Before pull checkpoint, even one that took no snapshot", async () => {
    const { t } = setup();
    const { projectId, conversationId } = await seedProject(t);
    const checkpointId = await beforePull(t, projectId);
    const run = (mode?: "plan") =>
      t.run((ctx) =>
        ctx.db.insert("messages", {
          projectId,
          conversationId,
          role: "assistant",
          content: "",
          status: "completed",
          ...(mode ? { mode } : {}),
        }),
      );
    const write = () =>
      t.mutation(api.githubSync.applyPulledFiles, {
        internalKey: INTERNAL_KEY,
        projectId,
        checkpointId,
        entries: [{ path: "index.html", type: "file", content: "<h1>from GitHub</h1>" }],
      });

    // A plan-mode reply writes nothing, so the pull may go on.
    await run("plan");
    await write();
    await run();

    await expect(write()).rejects.toMatchObject({ data: { code: "CONFLICT" } });
    await expect(
      t.mutation(api.githubSync.finishPull, { internalKey: INTERNAL_KEY, projectId, checkpointId, sha: "abc" }),
    ).rejects.toThrow(/changed during the pull/);
  });

  test("refuses to write once the sync was cancelled", async () => {
    const { t } = setup();
    const { projectId } = await seedProject(t);
    const checkpointId = await beforePull(t, projectId);
    await t.mutation(api.system.updateExportStatus, { internalKey: INTERNAL_KEY, projectId, status: "cancelled" });

    await expect(
      t.mutation(api.githubSync.applyPulledFiles, { internalKey: INTERNAL_KEY, projectId, checkpointId, entries: [] }),
    ).rejects.toMatchObject({ data: { code: "CONFLICT", message: expect.stringMatching(/^The pull was cancelled\. Restore/) } });
  });

  test("replaces most of a big project without going over the file cap", async () => {
    const { t } = setup();
    const { projectId } = await seedProject(t);
    // 1,100 local files and 1,100 different remote ones: 2,200 at once if the
    // new ones landed before the old ones went.
    await t.run(async (ctx) => {
      for (let i = 0; i < 1100; i++) {
        await ctx.db.insert("files", { projectId, name: `old-${i}.ts`, type: "file", content: "", updatedAt: 0 });
      }
    });
    const remote: TreeEntry[] = Array.from({ length: 1100 }, (_, i) => ({
      path: `new-${i}.ts`,
      type: "file",
      content: "",
    }));

    await pull(t, projectId, remote, 100);

    const files = Object.keys(await tree(t, projectId));
    expect(files).toHaveLength(1100);
    expect(files.every((path) => path.startsWith("new-"))).toBe(true);
  });
});
