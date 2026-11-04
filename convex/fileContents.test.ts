// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { withContents } from "./fileContents";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const INTERNAL_KEY = "test-internal-key";
const ALICE = "user_alice";
const BOB = "user_bob";

function setup() {
  // Real per-transaction limits, so batches that would overflow them fail here.
  const t = convexTest({ schema, modules, transactionLimits: true });
  return {
    t,
    alice: t.withIdentity({ subject: ALICE }),
    bob: t.withIdentity({ subject: BOB }),
  };
}

type T = ReturnType<typeof setup>["t"];

/**
 * Alice's project with `src/legacy.ts`, written before #412 (text on the
 * `files` doc), and `src/moved.ts`, created through the API (text in
 * `fileContents`).
 */
async function seedProject(t: T, alice: ReturnType<typeof setup>["alice"]) {
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "App", ownerId: ALICE, updatedAt: 0 });
    const srcId = await ctx.db.insert("files", { projectId, name: "src", type: "folder", updatedAt: 0 });
    const legacyId = await ctx.db.insert("files", {
      projectId,
      parentId: srcId,
      name: "legacy.ts",
      type: "file",
      content: "// legacy",
      updatedAt: 0,
    });
    return { projectId, srcId, legacyId };
  });
  const movedId = await alice.mutation(api.files.createFile, {
    projectId: ids.projectId,
    parentId: ids.srcId,
    name: "moved.ts",
    content: "// moved",
  });
  return { ...ids, movedId };
}

const contentRows = (t: T) => t.run((ctx) => ctx.db.query("fileContents").collect());

describe("fileContents (#412)", () => {
  beforeEach(() => {
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("updateFile writes the content row and leaves the files doc untouched", async () => {
    const { t, alice } = setup();
    const { movedId } = await seedProject(t, alice);
    const before = await t.run((ctx) => ctx.db.get("files", movedId));

    await alice.mutation(api.files.updateFile, { id: movedId, content: "// v2" });

    expect(await t.run((ctx) => ctx.db.get("files", movedId))).toEqual(before);
    expect(before).not.toHaveProperty("content");
    expect(await alice.query(api.files.getFile, { id: movedId })).toMatchObject({ content: "// v2" });
  });

  test("a legacy row reads its text until a write moves it", async () => {
    const { t, alice } = setup();
    const { projectId, legacyId } = await seedProject(t, alice);

    expect(await alice.query(api.files.getFile, { id: legacyId })).toMatchObject({ content: "// legacy" });
    expect(
      await t.query(api.system.getFileById, { internalKey: INTERNAL_KEY, projectId, fileId: legacyId }),
    ).toMatchObject({ content: "// legacy" });
    const withUrls = await alice.query(api.files.getFilesWithUrls, { projectId });
    expect(Object.fromEntries(withUrls.map((file) => [file.name, file.content]))).toEqual({
      src: undefined,
      "legacy.ts": "// legacy",
      "moved.ts": "// moved",
    });

    await t.mutation(api.system.updateFile, {
      internalKey: INTERNAL_KEY,
      projectId,
      fileId: legacyId,
      content: "// v2",
    });
    expect(await t.run((ctx) => ctx.db.get("files", legacyId))).not.toHaveProperty("content");
    expect(await alice.query(api.files.getFile, { id: legacyId })).toMatchObject({ content: "// v2" });
  });

  test("file lists return metadata only, for legacy and moved rows", async () => {
    const { t, alice } = setup();
    const { projectId, srcId } = await seedProject(t, alice);

    const lists = [
      await alice.query(api.files.getFiles, { projectId }),
      await alice.query(api.files.getFolderContents, { projectId, parentId: srcId }),
      await t.query(api.system.getProjectFiles, { internalKey: INTERNAL_KEY, projectId }),
    ];
    for (const files of lists) {
      expect(files.map((file) => file.name)).toEqual(expect.arrayContaining(["legacy.ts", "moved.ts"]));
      for (const file of files) expect(file).not.toHaveProperty("content");
    }
  });

  test("withContents finds the text of files outside a cut-short content range", async () => {
    const { t, alice } = setup();
    const { projectId } = await seedProject(t, alice);
    await alice.mutation(api.files.createFile, { projectId, name: "later.ts", content: "// later" });

    // One file of three text files: the range returns moved.ts's row, not later.ts's.
    const texts = await t.run(async (ctx) => {
      const files = await ctx.db
        .query("files")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .collect();
      const later = files.filter((file) => file.name === "later.ts");
      return (await withContents(ctx, projectId, later)).map((file) => file.content);
    });
    expect(texts).toEqual(["// later"]);
  });

  test("a list of 2,000 moved files reads only their metadata", async () => {
    const { t, alice } = setup();
    const projectId = await t.run((ctx) =>
      ctx.db.insert("projects", { name: "Big", ownerId: ALICE, updatedAt: 0 }),
    );
    await t.run(async (ctx) => {
      for (let i = 0; i < 2000; i++) {
        const fileId = await ctx.db.insert("files", { projectId, name: `f${i}.ts`, type: "file", updatedAt: 0 });
        await ctx.db.insert("fileContents", { fileId, projectId, content: "x".repeat(500) });
      }
    });

    const bytesRead = await alice.run(async (ctx) => {
      await ctx.runQuery(api.files.getFiles, { projectId });
      return (await ctx.meta.getTransactionMetrics()).bytesRead.used;
    });
    expect(bytesRead).toBeLessThan(2000 * 400);
  });

  test("backfill moves every legacy row in byte-capped batches, and a rerun moves none", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { t, alice } = setup();
    const { projectId } = await seedProject(t, alice);
    // 20 docs of ~900 KB: one fixed-count batch would read past the 16 MiB cap.
    const big = "x".repeat(900 * 1024);
    for (let i = 0; i < 20; i++) {
      await t.run((ctx) =>
        ctx.db.insert("files", { projectId, name: `big${i}.txt`, type: "file", content: big, updatedAt: 0 }),
      );
    }

    await t.mutation(internal.fileContents.backfill, { cursor: null, moved: 0 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(log).toHaveBeenCalledWith("[fileContents] backfill done, moved 21 files");

    // One file per read: the whole project's text is over a transaction's read cap.
    const files = await t.run((ctx) => ctx.db.query("files").collect());
    for (const file of files) {
      expect(file).not.toHaveProperty("content");
      if (file.type === "folder") continue;
      const { content } = await alice.query(api.files.getFile, { id: file._id });
      expect(content).toBe(
        { "legacy.ts": "// legacy", "moved.ts": "// moved" }[file.name] ?? big,
      );
    }

    await t.mutation(internal.fileContents.backfill, { cursor: null, moved: 0 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(log).toHaveBeenLastCalledWith("[fileContents] backfill done, moved 0 files");
  });

  test("deleting a file, a folder, an import's files or the project leaves no content rows", async () => {
    vi.useFakeTimers();
    const { t, alice } = setup();

    const one = await seedProject(t, alice);
    await alice.mutation(api.files.deleteFile, { id: one.movedId });
    expect((await contentRows(t)).map((row) => row.fileId)).not.toContain(one.movedId);
    await alice.mutation(api.files.deleteFile, { id: one.srcId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await contentRows(t)).toEqual([]);

    // A binary file the agent wrote text into still has its row removed.
    const binary = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["png"]));
      return ctx.db.insert("files", { projectId: one.projectId, name: "logo.png", type: "file", storageId, updatedAt: 0 });
    });
    await t.mutation(api.system.updateFile, { internalKey: INTERNAL_KEY, projectId: one.projectId, fileId: binary, content: "x" });
    await alice.mutation(api.files.deleteFile, { id: binary });
    expect(await contentRows(t)).toEqual([]);

    const two = await seedProject(t, alice);
    let done = false;
    while (!done) {
      ({ done } = await t.mutation(api.system.cleanup, { internalKey: INTERNAL_KEY, projectId: two.projectId }));
    }
    expect(await contentRows(t)).toEqual([]);

    const three = await seedProject(t, alice);
    await alice.mutation(api.projects.remove, { id: three.projectId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await contentRows(t)).toEqual([]);
  });

  test("duplicate copies the text to the new files, and later edits stay apart", async () => {
    vi.useFakeTimers();
    const { t, alice } = setup();
    const { projectId, legacyId, movedId } = await seedProject(t, alice);

    const copyId = await alice.mutation(api.projects.duplicate, { id: projectId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await alice.mutation(api.files.updateFile, { id: movedId, content: "// edited" });
    await alice.mutation(api.files.updateFile, { id: legacyId, content: "// edited" });

    const copy = await alice.query(api.files.getFilesWithUrls, { projectId: copyId });
    expect(Object.fromEntries(copy.map((file) => [file.name, file.content]))).toEqual({
      src: undefined,
      "legacy.ts": "// legacy",
      "moved.ts": "// moved",
    });
    const copyRows = (await contentRows(t)).filter((row) => row.projectId === copyId);
    expect(copyRows.map((row) => row.fileId).sort()).toEqual(
      copy.filter((file) => file.type === "file").map((file) => file._id).sort(),
    );
  });

  test("another user or project can't read the text", async () => {
    const { t, alice, bob } = setup();
    const { movedId, legacyId, projectId } = await seedProject(t, alice);
    const otherProjectId: Id<"projects"> = await t.run((ctx) =>
      ctx.db.insert("projects", { name: "Other", ownerId: ALICE, updatedAt: 0 }),
    );

    for (const id of [movedId, legacyId]) {
      await expect(bob.query(api.files.getFile, { id })).rejects.toThrow();
      expect(
        await t.query(api.system.getFileById, { internalKey: INTERNAL_KEY, projectId: otherProjectId, fileId: id }),
      ).toBeNull();
    }
    await expect(bob.query(api.files.getFilesWithUrls, { projectId })).rejects.toThrow();
  });
});
