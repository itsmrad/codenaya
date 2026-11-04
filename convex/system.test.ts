// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const INTERNAL_KEY = "test-internal-key";

type T = ReturnType<typeof convexTest>;

/** Two projects: A (the run's own) and B, each with a folder and a file. */
async function seedProjects(t: T) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const project = async (name: string) => {
      const projectId = await ctx.db.insert("projects", { name, ownerId: "user_alice", updatedAt: now });
      const folderId = await ctx.db.insert("files", { projectId, name: "src", type: "folder", updatedAt: now });
      const fileId = await ctx.db.insert("files", {
        projectId,
        parentId: folderId,
        name: "main.ts",
        type: "file",
        content: `// ${name}`,
        updatedAt: now,
      });
      return { projectId, folderId, fileId };
    };
    return { a: await project("A"), b: await project("B") };
  });
}

// Agent file tools must stay inside the run's project (#209).
describe("system file functions are scoped to the run's project", () => {
  beforeEach(() => {
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  test("getFileById returns the file only for its own project", async () => {
    const t = convexTest(schema, modules);
    const { a, b } = await seedProjects(t);
    const read = (fileId: typeof a.fileId) =>
      t.query(api.system.getFileById, { internalKey: INTERNAL_KEY, projectId: a.projectId, fileId });

    expect(await read(a.fileId)).toMatchObject({ name: "main.ts", content: "// A" });
    expect(await read(b.fileId)).toBeNull();
  });

  test("getFileById resolves a malformed or wrong-table id to null", async () => {
    const t = convexTest(schema, modules);
    const { a } = await seedProjects(t);
    const read = (fileId: string) =>
      t.query(api.system.getFileById, { internalKey: INTERNAL_KEY, projectId: a.projectId, fileId });

    expect(await read("src/App.tsx")).toBeNull();
    expect(await read(a.projectId)).toBeNull();
  });

  test("a foreign file cannot be updated, renamed or deleted", async () => {
    const t = convexTest(schema, modules);
    const { a, b } = await seedProjects(t);
    const scope = { internalKey: INTERNAL_KEY, projectId: a.projectId };
    const before = await t.run((ctx) => ctx.db.get("files", b.fileId));

    await expect(
      t.mutation(api.system.updateFile, { ...scope, fileId: b.fileId, content: "pwned" })
    ).rejects.toThrow("File not found");
    await expect(
      t.mutation(api.system.renameFile, { ...scope, fileId: b.fileId, newName: "pwned.ts" })
    ).rejects.toThrow("File not found");
    await expect(t.mutation(api.system.deleteFile, { ...scope, fileId: b.folderId })).rejects.toThrow(
      "File not found"
    );

    expect(await t.run((ctx) => ctx.db.get("files", b.fileId))).toEqual(before);
    expect(await t.run((ctx) => ctx.db.get("files", b.folderId))).not.toBeNull();
  });

  test("own files can still be updated, renamed and deleted", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { a } = await seedProjects(t);
    const scope = { internalKey: INTERNAL_KEY, projectId: a.projectId };

    await t.mutation(api.system.updateFile, { ...scope, fileId: a.fileId, content: "// v2" });
    await t.mutation(api.system.renameFile, { ...scope, fileId: a.fileId, newName: "app.ts" });
    expect(await t.query(api.system.getFileById, { ...scope, fileId: a.fileId })).toMatchObject({
      name: "app.ts",
      content: "// v2",
    });

    await t.mutation(api.system.deleteFile, { ...scope, fileId: a.folderId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.get("files", a.fileId))).toBeNull();
  });

  test("create functions reject a parent folder from another project", async () => {
    const t = convexTest(schema, modules);
    const { a, b } = await seedProjects(t);
    const scope = { internalKey: INTERNAL_KEY, projectId: a.projectId, parentId: b.folderId };
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["png"])));

    await expect(t.mutation(api.system.createFile, { ...scope, name: "x.ts", content: "" })).rejects.toThrow(
      "Parent folder not found"
    );
    await expect(
      t.mutation(api.system.createFiles, { ...scope, files: [{ name: "x.ts", content: "" }] })
    ).rejects.toThrow("Parent folder not found");
    await expect(t.mutation(api.system.createFolder, { ...scope, name: "lib" })).rejects.toThrow(
      "Parent folder not found"
    );
    await expect(
      t.mutation(api.system.createBinaryFile, { ...scope, name: "x.png", storageId })
    ).rejects.toThrow("Parent folder not found");

    const files = await t.run((ctx) => ctx.db.query("files").collect());
    expect(files).toHaveLength(4);
  });

  test("createBinaryFile refuses an unknown blob or one another project holds (#211)", async () => {
    const t = convexTest(schema, modules);
    const { a, b } = await seedProjects(t);
    const scope = { internalKey: INTERNAL_KEY, projectId: a.projectId, name: "logo.png" };
    const { foreign, missing } = await t.run(async (ctx) => {
      const foreign = await ctx.storage.store(new Blob(["png"]));
      await ctx.db.insert("files", {
        projectId: b.projectId,
        name: "logo.png",
        type: "file",
        storageId: foreign,
        updatedAt: 0,
      });
      const missing = await ctx.storage.store(new Blob(["png"]));
      await ctx.storage.delete(missing);
      return { foreign, missing };
    });

    for (const storageId of [foreign, missing]) {
      await expect(t.mutation(api.system.createBinaryFile, { ...scope, storageId })).rejects.toThrow(
        "Upload not found"
      );
    }

    const fresh = await t.run((ctx) => ctx.storage.store(new Blob(["png"])));
    const id = await t.mutation(api.system.createBinaryFile, { ...scope, storageId: fresh });
    expect(await t.run((ctx) => ctx.db.get("files", id))).toMatchObject({ storageId: fresh });
  });

  test("create functions reject a file as the parent and accept an own folder", async () => {
    const t = convexTest(schema, modules);
    const { a } = await seedProjects(t);
    const scope = { internalKey: INTERNAL_KEY, projectId: a.projectId };

    await expect(
      t.mutation(api.system.createFolder, { ...scope, parentId: a.fileId, name: "lib" })
    ).rejects.toThrow("Parent folder not found");

    const id = await t.mutation(api.system.createFile, {
      ...scope,
      parentId: a.folderId,
      name: "util.ts",
      content: "",
    });
    expect(await t.run((ctx) => ctx.db.get("files", id))).toMatchObject({
      projectId: a.projectId,
      parentId: a.folderId,
    });
  });
});

describe("system bounded reads and deletes", () => {
  beforeEach(() => {
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Reads only the newest `limit` messages, capped at 50 (#53).
  test("getRecentMessages returns the newest messages, oldest first", async () => {
    const t = convexTest(schema, modules);
    const conversationId = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "A", ownerId: "user_alice", updatedAt: 0 });
      const conversationId = await ctx.db.insert("conversations", { projectId, title: "c", updatedAt: 0 });
      for (let i = 0; i < 60; i++) {
        await ctx.db.insert("messages", { conversationId, projectId, role: "user", content: `m${i}` });
      }
      return conversationId;
    });
    const recent = (limit: number) =>
      t.query(api.system.getRecentMessages, { internalKey: INTERNAL_KEY, conversationId, limit });

    expect((await recent(3)).map((m) => m.content)).toEqual(["m57", "m58", "m59"]);
    const capped = await recent(1000);
    expect(capped).toHaveLength(50);
    expect(capped.at(-1)!.content).toBe("m59");
  });

  // One bounded batch per call; the caller repeats until done (#212).
  test("cleanup deletes the project's files in batches", async () => {
    const t = convexTest(schema, modules);
    const projectId = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", { name: "A", ownerId: "user_alice", updatedAt: 0 });
      for (let i = 0; i < 150; i++) {
        await ctx.db.insert("files", { projectId, name: `f${i}`, type: "file", content: "", updatedAt: 0 });
      }
      return projectId;
    });
    const cleanup = () => t.mutation(api.system.cleanup, { internalKey: INTERNAL_KEY, projectId });

    expect(await cleanup()).toEqual({ deleted: 100, done: false });
    expect(await cleanup()).toEqual({ deleted: 50, done: true });
    expect(await t.run((ctx) => ctx.db.query("files").collect())).toEqual([]);
  });
});
