// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MAX_CHECKPOINTS_PER_PROJECT } from "./checkpoints";
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
    const files = await ctx.db
      .query("files")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
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
  });

  test("restores adds, edits, deletes and folders in one round-trip", async () => {
    const { t, alice } = setup();
    const { projectId, conversationId, index, src, main } = await seedProject(t);
    const before = await tree(t, projectId);
    const messageId = await addRun(t, projectId, conversationId);
    await snapshot(t, projectId, messageId);

    // What an agent run might do: edit, create (in a new folder), delete.
    await t.mutation(api.system.updateFile, { internalKey: INTERNAL_KEY, fileId: index, content: "<h1>v2</h1>" });
    const lib = await t.mutation(api.system.createFolder, { internalKey: INTERNAL_KEY, projectId, name: "lib" });
    await t.mutation(api.system.createFile, { internalKey: INTERNAL_KEY, projectId, parentId: lib, name: "util.ts", content: "x" });
    await t.mutation(api.system.deleteFile, { internalKey: INTERNAL_KEY, fileId: src });
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
    await t.mutation(api.system.updateFile, { internalKey: INTERNAL_KEY, fileId: index, content: "<h1>v2</h1>" });
    expect(await snapshot(t, projectId, messageId)).toBe(first);

    await alice.mutation(api.checkpoints.restore, { checkpointId: first });
    expect((await tree(t, projectId))["index.html"]).toBe("<h1>v1</h1>");
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
        .withIndex("by_checkpoint", (q) => q.eq("checkpointId", ids[0]))
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
