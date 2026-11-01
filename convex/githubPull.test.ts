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

/** What the pull job does with a remote tree: checkpoint, batches, finish. */
async function pull(t: T, projectId: Id<"projects">, entries: TreeEntry[], batchSize = 2) {
  await t.mutation(api.system.createPullCheckpoint, {
    internalKey: INTERNAL_KEY,
    projectId,
    label: "Before pull from GitHub @ abc1234",
  });
  for (let i = 0; i < entries.length; i += batchSize) {
    await t.mutation(api.system.applyPulledFiles, {
      internalKey: INTERNAL_KEY,
      projectId,
      entries: entries.slice(i, i + batchSize),
    });
  }
  await t.mutation(api.system.finishPull, {
    internalKey: INTERNAL_KEY,
    projectId,
    sha: "abc1234def",
    tree: entries.map(({ path, type }) => ({ path, type })),
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

    await t.mutation(api.system.applyPulledFiles, {
      internalKey: INTERNAL_KEY,
      projectId,
      entries: [{ path: "src", type: "file", content: "now a file" }],
    });

    expect(await tree(t, projectId)).toMatchObject({ src: "now a file" });
    expect(Object.keys(await tree(t, projectId)).filter((path) => path.startsWith("src/"))).toEqual([]);
  });

  test("refuses to pull over a running agent or without the internal key", async () => {
    const { t } = setup();
    const { projectId, conversationId } = await seedProject(t);

    await expect(
      t.mutation(api.system.createPullCheckpoint, { internalKey: "wrong", projectId, label: "" }),
    ).rejects.toThrow();
    await t.run((ctx) =>
      ctx.db.insert("messages", { projectId, conversationId, role: "assistant", content: "", status: "processing" }),
    );
    await expect(
      t.mutation(api.system.createPullCheckpoint, { internalKey: INTERNAL_KEY, projectId, label: "" }),
    ).rejects.toThrow(/Stop the running agent/);
    await expect(
      t.mutation(api.system.applyPulledFiles, { internalKey: INTERNAL_KEY, projectId, entries: [] }),
    ).rejects.toThrow(/Stop the running agent/);
  });
});
