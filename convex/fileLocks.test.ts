// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const INTERNAL_KEY = "test-internal-key";
const ALICE = "user_alice";

const lockMessage = (path: string) =>
  `${path} is locked by the user. Don't modify it; explain the change you'd make instead.`;
const locked = (path: string) =>
  expect.objectContaining({ data: { code: "FORBIDDEN", message: lockMessage(path) } });

/** src/ (locked) > lib/ > util.ts, and app/ > header.tsx (locked) + footer.tsx. */
async function setup() {
  const t = convexTest(schema, modules);
  const alice = t.withIdentity({ subject: ALICE });
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "Mine", ownerId: ALICE, updatedAt: 0 });
    const file = (name: string, parentId?: Id<"files">, type: "file" | "folder" = "file") =>
      ctx.db.insert("files", { projectId, parentId, name, type, updatedAt: 0 });
    const srcId = await file("src", undefined, "folder");
    const libId = await file("lib", srcId, "folder");
    const utilId = await file("util.ts", libId);
    const appId = await file("app", undefined, "folder");
    const headerId = await file("header.tsx", appId);
    const footerId = await file("footer.tsx", appId);
    return { projectId, srcId, libId, utilId, appId, headerId, footerId };
  });
  await alice.mutation(api.files.setLocked, { id: ids.srcId, locked: true });
  await alice.mutation(api.files.setLocked, { id: ids.headerId, locked: true });
  const scope = { internalKey: INTERNAL_KEY, projectId: ids.projectId };
  return { t, alice, scope, ...ids };
}

describe("agent writes refuse locked paths (#307)", () => {
  beforeEach(() => vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY));
  afterEach(() => vi.unstubAllEnvs());

  test("a locked file, a file in nested folders under a locked folder, and the unlocked sibling", async () => {
    const { t, scope, headerId, utilId, footerId } = await setup();

    await expect(t.mutation(api.system.updateFile, { ...scope, fileId: headerId, content: "x" }))
      .rejects.toEqual(locked("app/header.tsx"));
    await expect(t.mutation(api.system.updateFile, { ...scope, fileId: utilId, content: "x" }))
      .rejects.toEqual(locked("src/lib/util.ts"));
    await expect(t.mutation(api.system.renameFile, { ...scope, fileId: headerId, newName: "h.tsx" }))
      .rejects.toEqual(locked("app/header.tsx"));
    await expect(t.mutation(api.system.deleteFile, { ...scope, fileId: utilId }))
      .rejects.toEqual(locked("src/lib/util.ts"));

    await t.mutation(api.system.updateFile, { ...scope, fileId: footerId, content: "ok" });
    const [header, footer] = await t.run(async (ctx) =>
      Promise.all([headerId, footerId].map(async (fileId) =>
        (await ctx.db.query("fileContents").withIndex("by_file", (q) => q.eq("fileId", fileId)).unique())?.content ?? null)),
    );
    expect(header).toBeNull();
    expect(footer).toBe("ok");
  });

  test("creating inside a locked folder is refused and writes nothing", async () => {
    const { t, scope, libId } = await setup();

    const results = await t.mutation(api.system.createFiles, {
      ...scope, parentId: libId, files: [{ name: "new.ts", content: "" }],
    });
    expect(results).toEqual([{ name: "new.ts", fileId: "", error: lockMessage("src/lib/new.ts") }]);
    await expect(t.mutation(api.system.createFolder, { ...scope, parentId: libId, name: "x" }))
      .rejects.toEqual(locked("src/lib/x"));

    const children = await t.run((ctx) =>
      ctx.db.query("files").withIndex("by_parent", (q) => q.eq("parentId", libId)).collect());
    expect(children.map((f) => f.name)).toEqual(["util.ts"]);
  });

  test("a folder holding a locked file can't be renamed or deleted", async () => {
    const { t, scope, appId } = await setup();

    await expect(t.mutation(api.system.renameFile, { ...scope, fileId: appId, newName: "web" }))
      .rejects.toEqual(locked("app/header.tsx"));
    await expect(t.mutation(api.system.deleteFile, { ...scope, fileId: appId }))
      .rejects.toEqual(locked("app/header.tsx"));
  });

  test("an uploaded binary can't be created inside a locked folder", async () => {
    const { t, scope, libId } = await setup();
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["png"])));

    await expect(t.mutation(api.system.createBinaryFile, { ...scope, parentId: libId, name: "logo.png", storageId }))
      .rejects.toEqual(locked("src/lib/logo.png"));
  });

  test("unlocking lets the agent write again", async () => {
    const { t, alice, scope, headerId } = await setup();

    await alice.mutation(api.files.setLocked, { id: headerId, locked: false });
    await t.mutation(api.system.updateFile, { ...scope, fileId: headerId, content: "x" });
    // Unlocked rows drop the field, so the lock index holds only locked rows.
    expect(await t.run(async (ctx) => "locked" in (await ctx.db.get(headerId))!)).toBe(false);
  });
});

describe("files.setLocked", () => {
  test("only the owner can lock", async () => {
    const { t, footerId } = await setup();
    await expect(
      t.withIdentity({ subject: "user_bob" }).mutation(api.files.setLocked, { id: footerId, locked: true }),
    ).rejects.toThrow();
  });

  test("signed out, nothing can be locked", async () => {
    const { t, footerId } = await setup();
    await expect(t.mutation(api.files.setLocked, { id: footerId, locked: true })).rejects.toThrow();
    expect(await t.run(async (ctx) => (await ctx.db.get(footerId))!.locked ?? false)).toBe(false);
  });

  test("restore keeps the current lock of files that still exist", async () => {
    const { t, alice, projectId, headerId, footerId } = await setup();
    const checkpointId = await t.run(async (ctx) => {
      const { createCheckpoint } = await import("./checkpoints");
      return createCheckpoint(ctx, { projectId, label: "before" });
    });
    await alice.mutation(api.files.setLocked, { id: headerId, locked: false });
    await alice.mutation(api.files.setLocked, { id: footerId, locked: true });

    await alice.mutation(api.checkpoints.restore, { checkpointId });

    const lockOf = (id: Id<"files">) => t.run(async (ctx) => (await ctx.db.get(id))!.locked ?? false);
    expect([await lockOf(headerId), await lockOf(footerId)]).toEqual([false, true]);
  });

  test("the lock survives duplicate and checkpoint restore", async () => {
    const { t, alice, projectId } = await setup();

    const copyId = await alice.mutation(api.projects.duplicate, { id: projectId });
    const lockedNames = (id: Id<"projects">) =>
      t.run(async (ctx) =>
        (await ctx.db.query("files").withIndex("by_project", (q) => q.eq("projectId", id)).collect())
          .filter((f) => f.locked).map((f) => f.name).sort());
    expect(await lockedNames(copyId)).toEqual(["header.tsx", "src"]);

    const checkpointId = await t.run(async (ctx) => {
      const { createCheckpoint } = await import("./checkpoints");
      return createCheckpoint(ctx, { projectId, label: "before" });
    });
    // Wipe the project, then restore: every file is recreated from the checkpoint.
    await t.run(async (ctx) => {
      for (const f of await ctx.db.query("files").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect()) {
        await ctx.db.delete(f._id);
      }
    });
    await alice.mutation(api.checkpoints.restore, { checkpointId });
    expect(await lockedNames(projectId)).toEqual(["header.tsx", "src"]);
  });
});
