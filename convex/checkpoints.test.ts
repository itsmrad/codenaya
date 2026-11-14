// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MAX_CHECKPOINTS_PER_PROJECT, MAX_DIFF_CHARS, MAX_DIFF_FILES, lineDelta } from "./checkpoints";
import { withContents } from "./fileContents";
import { deleteProjectBatch } from "./projectCascade";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const INTERNAL_KEY = "test-internal-key";
const ALICE = "user_alice";
const BOB = "user_bob";

function setup() {
  const t = convexTest(schema, modules);
  return {
    t,
    alice: t.withIdentity({ subject: ALICE }),
    bob: t.withIdentity({ subject: BOB }),
  };
}

type T = ReturnType<typeof setup>["t"];

/** A project with `index.html`, `src/main.ts` and `src/app.ts`. */
async function seedProject(t: T) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const projectId = await ctx.db.insert("projects", {
      name: "App",
      ownerId: ALICE,
      updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      projectId,
      title: "Chat",
      updatedAt: now,
    });
    const file = (name: string, content: string, parentId?: Id<"files">) =>
      ctx.db.insert("files", { projectId, parentId, name, type: "file", content, updatedAt: now });
    const index = await file("index.html", "<h1>v1</h1>");
    const src = await ctx.db.insert("files", { projectId, name: "src", type: "folder", updatedAt: now });
    const main = await file("main.ts", "console.log(1);", src);
    await file("app.ts", "export {};", src);
    return { projectId, conversationId, index, src, main };
  });
}

const addRun = (t: T, projectId: Id<"projects">, conversationId: Id<"conversations">) =>
  t.run((ctx) =>
    ctx.db.insert("messages", {
      projectId,
      conversationId,
      role: "assistant",
      content: "",
      status: "completed",
    }),
  );

const snapshot = (t: T, projectId: Id<"projects">, messageId: Id<"messages">, label = "Make it blue") =>
  t.mutation(api.system.createProjectCheckpoint, {
    internalKey: INTERNAL_KEY,
    projectId,
    messageId,
    label,
  });

/** The project's files as `path → content`, folders as `path/`. */
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

describe("checkpoints", () => {
  beforeEach(() => {
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  test("restores adds, edits, deletes and folders in one round-trip", async () => {
    vi.useFakeTimers();
    const { t, alice } = setup();
    const { projectId, conversationId, index, src, main } = await seedProject(t);
    const before = await tree(t, projectId);
    const messageId = await addRun(t, projectId, conversationId);
    await snapshot(t, projectId, messageId);

    // What an agent run might do: edit, create (in a new folder), delete.
    await t.mutation(api.system.updateFile, { internalKey: INTERNAL_KEY, projectId, fileId: index, content: "<h1>v2</h1>" });
    const lib = await t.mutation(api.system.createFolder, { internalKey: INTERNAL_KEY, projectId, name: "lib" });
    await t.mutation(api.system.createFile, { internalKey: INTERNAL_KEY, projectId, parentId: lib, name: "util.ts", content: "x" });
    await t.mutation(api.system.deleteFile, { internalKey: INTERNAL_KEY, projectId, fileId: src });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await tree(t, projectId)).not.toEqual(before);

    const [checkpoint] = await alice.query(api.checkpoints.list, { projectId });
    expect(checkpoint).toMatchObject({ messageId, label: "Make it blue", fileCount: 3 });
    await alice.mutation(api.checkpoints.restore, { checkpointId: checkpoint._id });

    expect(await tree(t, projectId)).toEqual(before);
    // Unchanged paths keep their ids, so open editor tabs stay valid.
    expect(await t.run((ctx) => ctx.db.get("files", index))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.get("files", main))).toBeNull();
  });

  test("snapshots once per run, so a replayed step keeps the pre-run files", async () => {
    const { t, alice } = setup();
    const { projectId, conversationId, index } = await seedProject(t);
    const messageId = await addRun(t, projectId, conversationId);
    const first = await snapshot(t, projectId, messageId);
    await t.mutation(api.system.updateFile, { internalKey: INTERNAL_KEY, projectId, fileId: index, content: "<h1>v2</h1>" });
    expect(await snapshot(t, projectId, messageId)).toBe(first);

    await alice.mutation(api.checkpoints.restore, { checkpointId: first });
    expect((await tree(t, projectId))["index.html"]).toBe("<h1>v1</h1>");
  });

  test("restores a path that turned binary or text, leaving no stray content rows (#412)", async () => {
    vi.useFakeTimers();
    const { t, alice } = setup();
    const { projectId, conversationId, index } = await seedProject(t);
    const scope = { internalKey: INTERNAL_KEY, projectId };
    const blob = () => t.run((ctx) => ctx.storage.store(new Blob(["png"])));
    const logo = await t.mutation(api.system.createBinaryFile, { ...scope, name: "logo.png", storageId: await blob() });
    const before = await tree(t, projectId);
    await snapshot(t, projectId, await addRun(t, projectId, conversationId));

    await t.mutation(api.system.deleteFile, { ...scope, fileId: index });
    await t.mutation(api.system.createBinaryFile, { ...scope, name: "index.html", storageId: await blob() });
    await t.mutation(api.system.deleteFile, { ...scope, fileId: logo });
    await t.mutation(api.system.createFile, { ...scope, name: "logo.png", content: "not a png" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const [checkpoint] = await alice.query(api.checkpoints.list, { projectId });
    await alice.mutation(api.checkpoints.restore, { checkpointId: checkpoint._id });

    expect(await tree(t, projectId)).toEqual(before);
    const { files, rows } = await t.run(async (ctx) => ({
      files: await ctx.db.query("files").collect(),
      rows: await ctx.db.query("fileContents").collect(),
    }));
    // Each text file's text lives in exactly one place (legacy field or row); no row outlives its file.
    const rowFileIds = new Set(rows.map((row) => row.fileId));
    expect(rowFileIds.size).toBe(rows.length);
    for (const file of files) {
      const isText = file.type === "file" && !file.storageId;
      expect(Number(rowFileIds.has(file._id)) + Number(file.content !== undefined)).toBe(isText ? 1 : 0);
      rowFileIds.delete(file._id);
    }
    expect(rowFileIds.size).toBe(0);
  });

  test(`keeps the newest ${MAX_CHECKPOINTS_PER_PROJECT} per project`, async () => {
    const { t, alice } = setup();
    const { projectId, conversationId } = await seedProject(t);
    const ids: Id<"checkpoints">[] = [];
    for (let run = 0; run <= MAX_CHECKPOINTS_PER_PROJECT; run++) {
      ids.push(await snapshot(t, projectId, await addRun(t, projectId, conversationId), `run ${run}`));
    }

    const list = await alice.query(api.checkpoints.list, { projectId });
    expect(list).toHaveLength(MAX_CHECKPOINTS_PER_PROJECT);
    expect(list[0].label).toBe(`run ${MAX_CHECKPOINTS_PER_PROJECT}`);
    expect(await t.run((ctx) => ctx.db.get("checkpoints", ids[0]))).toBeNull();
    const orphans = await t.run((ctx) =>
      ctx.db
        .query("checkpointFiles")
        .withIndex("by_checkpoint_and_path", (q) => q.eq("checkpointId", ids[0]))
        .collect(),
    );
    expect(orphans).toEqual([]);
  });

  test("only the owner can list or restore", async () => {
    const { t, bob } = setup();
    const { projectId, conversationId } = await seedProject(t);
    const checkpointId = await snapshot(t, projectId, await addRun(t, projectId, conversationId));

    await expect(bob.query(api.checkpoints.list, { projectId })).rejects.toThrow(/Unauthorized/);
    await expect(bob.mutation(api.checkpoints.restore, { checkpointId })).rejects.toThrow(/Unauthorized/);
    await expect(t.mutation(api.checkpoints.restore, { checkpointId })).rejects.toThrow(/Unauthorized/);
  });

  test("rejects a snapshot without the internal key or for another project's message", async () => {
    const { t } = setup();
    const { projectId, conversationId } = await seedProject(t);
    const other = await seedProject(t);
    const messageId = await addRun(t, projectId, conversationId);

    await expect(
      t.mutation(api.system.createProjectCheckpoint, { internalKey: "wrong", projectId, messageId, label: "" }),
    ).rejects.toThrow(/Invalid internal key/);
    await expect(snapshot(t, other.projectId, messageId)).rejects.toThrow(/Message not found/);
  });

  test("refuses to restore while an agent run is in progress", async () => {
    const { t, alice } = setup();
    const { projectId, conversationId } = await seedProject(t);
    const checkpointId = await snapshot(t, projectId, await addRun(t, projectId, conversationId));
    await t.run((ctx) =>
      ctx.db.insert("messages", { projectId, conversationId, role: "assistant", content: "", status: "processing" }),
    );

    await expect(alice.mutation(api.checkpoints.restore, { checkpointId })).rejects.toThrow(/running agent/);
  });

  // A snapshot from before the 2000-file cap is refused whole, never half-restored (#212).
  test("refuses to restore a checkpoint over the file cap and leaves the files alone", async () => {
    const { t, alice } = setup();
    const { projectId, conversationId } = await seedProject(t);
    const checkpointId = await snapshot(t, projectId, await addRun(t, projectId, conversationId));
    await t.run(async (ctx) => {
      for (let i = 0; i < 2000; i++) {
        await ctx.db.insert("checkpointFiles", { checkpointId, projectId, path: `extra/${i}.ts`, type: "file", content: "" });
      }
    });
    const before = await tree(t, projectId);

    await expect(alice.mutation(api.checkpoints.restore, { checkpointId })).rejects.toMatchObject({
      data: { code: "LIMIT_EXCEEDED" },
    });
    expect(await tree(t, projectId)).toEqual(before);
  });

  test("keeps a deleted binary file's blob while a checkpoint needs it", async () => {
    const { t, alice } = setup();
    const { projectId, conversationId } = await seedProject(t);
    const { fileId, storageId } = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["png"]));
      const fileId = await ctx.db.insert("files", {
        projectId,
        name: "logo.png",
        type: "file",
        storageId,
        updatedAt: Date.now(),
      });
      return { fileId, storageId };
    });
    const checkpointId = await snapshot(t, projectId, await addRun(t, projectId, conversationId));

    await alice.mutation(api.files.deleteFile, { id: fileId });
    expect(await t.run((ctx) => ctx.db.system.get(storageId))).not.toBeNull();

    await alice.mutation(api.checkpoints.restore, { checkpointId });
    expect((await tree(t, projectId))["logo.png"]).toBe(storageId);
    expect(await t.run((ctx) => ctx.db.system.get(storageId))).not.toBeNull();
  });

  test("project deletion removes its checkpoints", async () => {
    const { t } = setup();
    const { projectId, conversationId } = await seedProject(t);
    await snapshot(t, projectId, await addRun(t, projectId, conversationId));

    await t.run(async (ctx) => {
      while (!(await deleteProjectBatch(ctx, projectId))) {
        // Each call deletes one batch.
      }
    });

    const left = await t.run(async (ctx) => ({
      checkpoints: await ctx.db.query("checkpoints").collect(),
      checkpointFiles: await ctx.db.query("checkpointFiles").collect(),
    }));
    expect(left).toEqual({ checkpoints: [], checkpointFiles: [] });
  });
});

/** A finished tool step, as the agent records it. */
const step = (tool: string, targets: string[], status: "done" | "error" = "done") => ({
  id: `${tool}:${targets.join(",")}`,
  kind: "tool" as const,
  tool,
  targets,
  status,
  startedAt: 0,
});

const setSteps = (t: T, messageId: Id<"messages">, steps: ReturnType<typeof step>[]) =>
  t.run((ctx) => ctx.db.patch("messages", messageId, { steps }));

describe("lineDelta", () => {
  test("counts lines like git diff --stat", () => {
    expect(lineDelta("a\nb\nc\n", "a\nB\nc\n")).toEqual({ additions: 1, deletions: 1 });
    expect(lineDelta("a\nb\n", "a\nb\nc\nd\n")).toEqual({ additions: 2, deletions: 0 });
    expect(lineDelta("a\nb\nc\n", "a\n")).toEqual({ additions: 0, deletions: 2 });
    expect(lineDelta("same\n", "same\n")).toEqual({ additions: 0, deletions: 0 });
    // Added and deleted files.
    expect(lineDelta("", "x\ny\n")).toEqual({ additions: 2, deletions: 0 });
    expect(lineDelta("x\ny", "")).toEqual({ additions: 0, deletions: 2 });
  });
});

describe("run changes (#225)", () => {
  beforeEach(() => {
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  /** A run that edits index.html, adds lib/util.ts and deletes the src folder. */
  async function seedRun() {
    const { t, alice, bob } = setup();
    const seeded = await seedProject(t);
    const { projectId, conversationId, index, src } = seeded;
    const scope = { internalKey: INTERNAL_KEY, projectId };
    const messageId = await addRun(t, projectId, conversationId);
    const checkpointId = await snapshot(t, projectId, messageId);

    await t.mutation(api.system.updateFile, { ...scope, fileId: index, content: "<h1>v2</h1>" });
    const lib = await t.mutation(api.system.createFolder, { ...scope, name: "lib" });
    await t.mutation(api.system.createFile, { ...scope, parentId: lib, name: "util.ts", content: "a\nb\n" });
    await t.mutation(api.system.deleteFile, { ...scope, fileId: src });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await setSteps(t, messageId, [
      step("readFiles", ["notes.md"]),
      step("updateFile", ["index.html"]),
      step("createFiles", ["lib/util.ts"]),
      step("deleteFiles", ["src"]),
      // A failed write changed nothing.
      step("updateFile", ["notes.md"], "error"),
    ]);
    // A manual edit outside the run's paths.
    await t.mutation(api.system.createFile, { ...scope, name: "notes.md", content: "mine" });
    return { t, alice, bob, ...seeded, scope, messageId, checkpointId };
  }

  test("lists only what the run wrote, with status and line counts", async () => {
    vi.useFakeTimers();
    const { alice, checkpointId } = await seedRun();

    expect(await alice.query(api.checkpoints.listChanges, { checkpointId })).toEqual([
      { path: "index.html", status: "modified", binary: false, tooLarge: false, additions: 1, deletions: 1 },
      { path: "lib/util.ts", status: "added", binary: false, tooLarge: false, additions: 2, deletions: 0 },
      { path: "src/app.ts", status: "deleted", binary: false, tooLarge: false, additions: 0, deletions: 1 },
      { path: "src/main.ts", status: "deleted", binary: false, tooLarge: false, additions: 0, deletions: 1 },
    ]);
    expect(await alice.query(api.checkpoints.fileDiff, { checkpointId, path: "index.html" })).toMatchObject({
      before: "<h1>v1</h1>",
      after: "<h1>v2</h1>",
    });
    expect(await alice.query(api.checkpoints.fileDiff, { checkpointId, path: "notes.md" })).toBeNull();
  });

  test("an earlier run diffs against the next run's snapshot, not the live files", async () => {
    const { t, alice } = setup();
    const { projectId, conversationId, index } = await seedProject(t);
    const scope = { internalKey: INTERNAL_KEY, projectId };
    const first = await addRun(t, projectId, conversationId);
    const checkpointId = await snapshot(t, projectId, first);
    await t.mutation(api.system.updateFile, { ...scope, fileId: index, content: "<h1>v2</h1>" });
    await setSteps(t, first, [step("updateFile", ["index.html"])]);

    const second = await addRun(t, projectId, conversationId);
    await snapshot(t, projectId, second);
    await t.mutation(api.system.updateFile, { ...scope, fileId: index, content: "<h1>v3</h1>" });

    expect(await alice.query(api.checkpoints.fileDiff, { checkpointId, path: "index.html" })).toMatchObject({
      before: "<h1>v1</h1>",
      after: "<h1>v2</h1>",
    });
  });

  test("follows a rename and leaves binary and huge files without contents", async () => {
    const { t, alice } = setup();
    const { projectId, conversationId, main } = await seedProject(t);
    const scope = { internalKey: INTERNAL_KEY, projectId };
    const messageId = await addRun(t, projectId, conversationId);
    const checkpointId = await snapshot(t, projectId, messageId);

    await t.mutation(api.system.renameFile, { ...scope, fileId: main, newName: "entry.ts" });
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["png"])));
    await t.mutation(api.system.createBinaryFile, { ...scope, name: "logo.png", storageId });
    await t.mutation(api.system.createFile, { ...scope, name: "big.txt", content: "x".repeat(MAX_DIFF_CHARS + 1) });
    await setSteps(t, messageId, [
      step("renameFile", ["src/main.ts", "entry.ts"]),
      step("createFiles", ["logo.png", "big.txt"]),
    ]);

    const changes = (await alice.query(api.checkpoints.listChanges, { checkpointId }))!;
    expect(changes.map(({ path, status }) => `${status} ${path}`)).toEqual([
      "added big.txt",
      "added logo.png",
      "added src/entry.ts",
      "deleted src/main.ts",
    ]);
    expect(changes[0]).toEqual({ path: "big.txt", status: "added", binary: false, tooLarge: true });
    expect(changes[1]).toEqual({ path: "logo.png", status: "added", binary: true, tooLarge: false });
    const diff = await alice.query(api.checkpoints.fileDiff, { checkpointId, path: "logo.png" });
    expect(diff).not.toHaveProperty("before");
    expect(diff).not.toHaveProperty("after");
  });

  test("reverts one file and leaves the run's other changes alone", async () => {
    vi.useFakeTimers();
    const { t, alice, checkpointId, projectId } = await seedRun();

    await alice.mutation(api.checkpoints.revertFile, { checkpointId, path: "index.html" });
    expect(await tree(t, projectId)).toEqual({
      "index.html": "<h1>v1</h1>",
      "lib/": null,
      "lib/util.ts": "a\nb\n",
      "notes.md": "mine",
    });

    // A file the run created is deleted; one it deleted comes back with its folder.
    await alice.mutation(api.checkpoints.revertFile, { checkpointId, path: "lib/util.ts" });
    await alice.mutation(api.checkpoints.revertFile, { checkpointId, path: "src/main.ts" });
    expect(await tree(t, projectId)).toEqual({
      "index.html": "<h1>v1</h1>",
      "lib/": null,
      "notes.md": "mine",
      "src/": null,
      "src/main.ts": "console.log(1);",
    });
    expect(
      (await alice.query(api.checkpoints.listChanges, { checkpointId }))!.map(({ path }) => path),
    ).toEqual(["src/app.ts"]);
  });

  test("puts back a binary file's blob", async () => {
    const { t, alice } = setup();
    const { projectId, conversationId } = await seedProject(t);
    const scope = { internalKey: INTERNAL_KEY, projectId };
    const blob = () => t.run((ctx) => ctx.storage.store(new Blob(["png"])));
    const original = await blob();
    const logo = await t.mutation(api.system.createBinaryFile, { ...scope, name: "logo.png", storageId: original });
    const messageId = await addRun(t, projectId, conversationId);
    const checkpointId = await snapshot(t, projectId, messageId);
    await t.mutation(api.system.deleteFile, { ...scope, fileId: logo });
    await t.mutation(api.system.createFile, { ...scope, name: "logo.png", content: "not a png" });
    await setSteps(t, messageId, [step("updateFile", ["logo.png"])]);

    await alice.mutation(api.checkpoints.revertFile, { checkpointId, path: "logo.png" });
    expect((await tree(t, projectId))["logo.png"]).toBe(original);
    // The text the run wrote is gone with it.
    const rows = await t.run((ctx) => ctx.db.query("fileContents").collect());
    expect(rows.map((row) => row.content)).not.toContain("not a png");
  });

  test("refuses to revert a path the run didn't write", async () => {
    vi.useFakeTimers();
    const { t, alice, checkpointId, projectId } = await seedRun();
    const before = await tree(t, projectId);

    // notes.md was made by hand after the run; reverting it would delete it.
    await expect(
      alice.mutation(api.checkpoints.revertFile, { checkpointId, path: "notes.md" }),
    ).rejects.toThrow(/didn't change that file/);
    expect(await tree(t, projectId)).toEqual(before);
  });

  test(`gives no list past ${MAX_DIFF_FILES} files, but still diffs one of them`, async () => {
    vi.useFakeTimers();
    const { t, alice } = setup();
    const { projectId, conversationId } = await seedProject(t);
    const big = await t.run(async (ctx) => {
      const folder = await ctx.db.insert("files", { projectId, name: "big", type: "folder", updatedAt: 0 });
      for (let i = 0; i <= MAX_DIFF_FILES; i++) {
        await ctx.db.insert("files", { projectId, parentId: folder, name: `f${i}.ts`, type: "file", content: "x", updatedAt: 0 });
      }
      return folder;
    });
    const messageId = await addRun(t, projectId, conversationId);
    const checkpointId = await snapshot(t, projectId, messageId);
    await t.mutation(api.system.deleteFile, { internalKey: INTERNAL_KEY, projectId, fileId: big });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await setSteps(t, messageId, [step("deleteFiles", ["big"])]);

    expect(await alice.query(api.checkpoints.listChanges, { checkpointId })).toBeNull();
    expect(await alice.query(api.checkpoints.fileDiff, { checkpointId, path: "big/f0.ts" })).toMatchObject({
      status: "deleted",
      before: "x",
      after: "",
    });
  });

  test("refuses to revert while an agent run is in progress", async () => {
    vi.useFakeTimers();
    const { t, alice, checkpointId, projectId, conversationId } = await seedRun();
    await t.run((ctx) =>
      ctx.db.insert("messages", { projectId, conversationId, role: "assistant", content: "", status: "processing" }),
    );

    await expect(
      alice.mutation(api.checkpoints.revertFile, { checkpointId, path: "index.html" }),
    ).rejects.toThrow(/Stop the running agent before reverting/);
    expect((await tree(t, projectId))["index.html"]).toBe("<h1>v2</h1>");
  });

  test("only the owner can list, diff or revert", async () => {
    vi.useFakeTimers();
    const { t, bob, checkpointId } = await seedRun();
    const path = "index.html";

    await expect(bob.query(api.checkpoints.listChanges, { checkpointId })).rejects.toThrow(/Unauthorized/);
    await expect(bob.query(api.checkpoints.fileDiff, { checkpointId, path })).rejects.toThrow(/Unauthorized/);
    await expect(bob.mutation(api.checkpoints.revertFile, { checkpointId, path })).rejects.toThrow(/Unauthorized/);
    await expect(t.query(api.checkpoints.listChanges, { checkpointId })).rejects.toThrow(/Unauthorized/);
  });
});
