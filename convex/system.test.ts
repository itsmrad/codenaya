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
  });

  test("getFileById returns the file only for its own project", async () => {
    const t = convexTest(schema, modules);
    const { a, b } = await seedProjects(t);
    const read = (fileId: typeof a.fileId) =>
      t.query(api.system.getFileById, { internalKey: INTERNAL_KEY, projectId: a.projectId, fileId });

    expect(await read(a.fileId)).toMatchObject({ name: "main.ts", content: "// A" });
    expect(await read(b.fileId)).toBeNull();
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
    const t = convexTest(schema, modules);
    const { a } = await seedProjects(t);
    const scope = { internalKey: INTERNAL_KEY, projectId: a.projectId };

    await t.mutation(api.system.updateFile, { ...scope, fileId: a.fileId, content: "// v2" });
    await t.mutation(api.system.renameFile, { ...scope, fileId: a.fileId, newName: "app.ts" });
    expect(await t.run((ctx) => ctx.db.get("files", a.fileId))).toMatchObject({
      name: "app.ts",
      content: "// v2",
    });

    await t.mutation(api.system.deleteFile, { ...scope, fileId: a.folderId });
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
