// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const ALICE = "user_alice";

/** Two of Alice's projects, one with a folder holding a file. */
async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "Mine", ownerId: ALICE, updatedAt: 0 });
    const otherProjectId = await ctx.db.insert("projects", {
      name: "Other",
      ownerId: "user_bob",
      updatedAt: 0,
    });
    const otherFolderId = await ctx.db.insert("files", {
      projectId: otherProjectId,
      name: "secret",
      type: "folder",
      updatedAt: 0,
    });
    const folderId = await ctx.db.insert("files", { projectId, name: "src", type: "folder", updatedAt: 0 });
    const fileId = await ctx.db.insert("files", {
      projectId,
      parentId: folderId,
      name: "app.ts",
      type: "file",
      content: "",
      updatedAt: 0,
    });
    return { projectId, otherFolderId, folderId, fileId };
  });
  return { t, alice: t.withIdentity({ subject: ALICE }), ...ids };
}

describe("files.createFile / createFolder", () => {
  test("reject a parent from another project or a parent that is a file (#239)", async () => {
    const { alice, projectId, otherFolderId, fileId } = await setup();

    for (const parentId of [otherFolderId, fileId]) {
      await expect(
        alice.mutation(api.files.createFile, { projectId, parentId, name: "x.ts", content: "" })
      ).rejects.toThrow("Parent folder not found");
      await expect(
        alice.mutation(api.files.createFolder, { projectId, parentId, name: "x" })
      ).rejects.toThrow("Parent folder not found");
    }
  });

  test("accept a folder of the same project", async () => {
    const { t, alice, projectId, folderId } = await setup();

    await alice.mutation(api.files.createFile, { projectId, parentId: folderId, name: "b.ts", content: "" });
    await alice.mutation(api.files.createFolder, { projectId, parentId: folderId, name: "lib" });

    const children = await t.run((ctx) =>
      ctx.db
        .query("files")
        .withIndex("by_project_and_parent_and_name", (q) => q.eq("projectId", projectId).eq("parentId", folderId))
        .collect()
    );
    expect(children.map((f) => f.name).sort()).toEqual(["app.ts", "b.ts", "lib"]);
  });
});

describe("files.getFilePath", () => {
  test("stops at the project boundary (#239)", async () => {
    const { t, alice, folderId, otherFolderId, fileId } = await setup();
    // A parent link planted before createFile checked parents.
    await t.run((ctx) => ctx.db.patch(folderId, { parentId: otherFolderId }));

    const path = await alice.query(api.files.getFilePath, { id: fileId });
    expect(path.map((p) => p.name)).toEqual(["src", "app.ts"]);
  });
});

const conflict = (message: string) =>
  expect.objectContaining({ data: { code: "CONFLICT", message } });

test("duplicate names throw a typed CONFLICT the explorer can show (#267)", async () => {
  const t = convexTest(schema, modules);
  const alice = t.withIdentity({ subject: "user_alice" });
  const projectId = await t.run((ctx) =>
    ctx.db.insert("projects", { name: "p", ownerId: "user_alice", updatedAt: 0 })
  );
  const file = { projectId, name: "a.ts", content: "" };
  await alice.mutation(api.files.createFile, file);
  await alice.mutation(api.files.createFile, { ...file, name: "b.ts" });
  await alice.mutation(api.files.createFolder, { projectId, name: "src" });

  const duplicate = alice.mutation(api.files.createFile, file);
  await expect(duplicate).rejects.toBeInstanceOf(ConvexError);
  await expect(duplicate).rejects.toEqual(conflict("File already exists"));
  await expect(alice.mutation(api.files.createFolder, { projectId, name: "src" })).rejects.toEqual(
    conflict("Folder already exists")
  );

  const files = await alice.query(api.files.getFolderContents, { projectId });
  const b = files.find((f) => f.name === "b.ts")!;
  await expect(alice.mutation(api.files.renameFile, { id: b._id, newName: "a.ts" })).rejects.toEqual(
    conflict("A file with this name already exists in this location")
  );
});

describe("files.deleteFile", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Descendants go in scheduled batches, so no transaction holds them all (#212).
  test("deletes a folder with more than 1,000 descendants", async () => {
    vi.useFakeTimers();
    const { t, alice, projectId, folderId } = await setup();
    await t.run(async (ctx) => {
      const lib = await ctx.db.insert("files", { projectId, parentId: folderId, name: "lib", type: "folder", updatedAt: 0 });
      for (let i = 0; i < 1000; i++) {
        const parentId = i % 2 ? lib : folderId;
        await ctx.db.insert("files", { projectId, parentId, name: `f${i}.ts`, type: "file", content: "", updatedAt: 0 });
      }
    });

    await alice.mutation(api.files.deleteFile, { id: folderId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const left = await t.run((ctx) =>
      ctx.db.query("files").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect()
    );
    expect(left).toEqual([]);
  });
});

// getOwnedProject treats a project being deleted as gone (#212).
test("file reads and writes on a project being deleted throw NOT_FOUND", async () => {
  const { t, alice, projectId, fileId } = await setup();
  await t.run((ctx) => ctx.db.patch("projects", projectId, { deletingAt: 1 }));
  const notFound = expect.objectContaining({ data: expect.objectContaining({ code: "NOT_FOUND" }) });

  await expect(alice.query(api.files.getFiles, { projectId })).rejects.toEqual(notFound);
  await expect(alice.query(api.files.getFile, { id: fileId })).rejects.toEqual(notFound);
  await expect(alice.mutation(api.files.updateFile, { id: fileId, content: "x" })).rejects.toEqual(notFound);
  await expect(
    alice.mutation(api.files.createFile, { projectId, name: "n.ts", content: "" })
  ).rejects.toEqual(notFound);
});
