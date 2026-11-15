// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const ALICE = "user_alice";
const BOB = "user_bob";

type T = ReturnType<typeof convexTest>;

/** Alice's project with a nested file, a binary file and the private data a share must never show. */
async function seed(t: T) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("users", { clerkUserId: ALICE, name: "Alice", email: "alice@example.com", updatedAt: now });
    const projectId = await ctx.db.insert("projects", {
      name: "Todo app",
      ownerId: ALICE,
      updatedAt: now,
      instructions: "private instructions",
    });
    const srcId = await ctx.db.insert("files", { projectId, name: "src", type: "folder", updatedAt: now });
    const indexId = await ctx.db.insert("files", {
      projectId,
      parentId: srcId,
      name: "index.ts",
      type: "file",
      updatedAt: now,
    });
    await ctx.db.insert("fileContents", { fileId: indexId, projectId, content: "export {};" });
    const storageId = await ctx.storage.store(new Blob(["png"]));
    const logoId = await ctx.db.insert("files", { projectId, name: "logo.png", type: "file", storageId, updatedAt: now });
    const conversationId = await ctx.db.insert("conversations", { projectId, title: "Chat", updatedAt: now });
    await ctx.db.insert("messages", { conversationId, projectId, role: "user", content: "secret chat" });
    await ctx.db.insert("projectEnvVars", {
      projectId,
      ownerId: ALICE,
      key: "PUBLIC_URL",
      visibility: "public",
      plainValue: "https://example.com",
      maskedPreview: "https://…",
      source: "manual",
      updatedAt: now,
    });
    return { projectId, srcId, indexId, logoId };
  });
}

const alice = (t: T) => t.withIdentity({ subject: ALICE });
const bob = (t: T) => t.withIdentity({ subject: BOB });

describe("share links (#260)", () => {
  test("a non-owner can't create or revoke a link", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seed(t);

    await expect(bob(t).action(api.projects.createShareLink, { projectId })).rejects.toThrow(
      "Unauthorized access to this project",
    );
    const token = await alice(t).action(api.projects.createShareLink, { projectId });
    await expect(bob(t).mutation(api.projects.revokeShareLink, { projectId })).rejects.toThrow(
      "Unauthorized access to this project",
    );
    expect(await t.query(api.projects.getShared, { token })).not.toBeNull();
  });

  test("the token is unguessable and stable until revoked", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seed(t);

    const token = await alice(t).action(api.projects.createShareLink, { projectId });
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(await alice(t).action(api.projects.createShareLink, { projectId })).toBe(token);

    await alice(t).mutation(api.projects.revokeShareLink, { projectId });
    const next = await alice(t).action(api.projects.createShareLink, { projectId });
    expect(next).not.toBe(token);
  });

  test("getShared returns only the name, owner name and file tree", async () => {
    const t = convexTest(schema, modules);
    const { projectId, srcId, indexId, logoId } = await seed(t);
    const token = await alice(t).action(api.projects.createShareLink, { projectId });

    // Signed out.
    const shared = await t.query(api.projects.getShared, { token });

    expect(Object.keys(shared!).sort()).toEqual(["files", "name", "ownerName"]);
    expect(shared).toMatchObject({ name: "Todo app", ownerName: "Alice" });
    for (const file of shared!.files) {
      expect(Object.keys(file).sort()).toEqual(["_id", "binary", "name", "parentId", "type"]);
    }
    expect(shared!.files).toEqual(
      expect.arrayContaining([
        { _id: srcId, parentId: null, name: "src", type: "folder", binary: false },
        { _id: indexId, parentId: srcId, name: "index.ts", type: "file", binary: false },
        { _id: logoId, parentId: null, name: "logo.png", type: "file", binary: true },
      ]),
    );
    const text = JSON.stringify(shared);
    for (const secret of ["private instructions", "secret chat", "PUBLIC_URL", "alice@example.com", ALICE]) {
      expect(text).not.toContain(secret);
    }
  });

  test("getSharedFile returns a shared file's text and nothing from other projects", async () => {
    const t = convexTest(schema, modules);
    const { projectId, indexId, logoId } = await seed(t);
    const other = await seed(t);
    const token = await alice(t).action(api.projects.createShareLink, { projectId });

    expect(await t.query(api.projects.getSharedFile, { token, fileId: indexId })).toEqual({
      content: "export {};",
    });
    expect(await t.query(api.projects.getSharedFile, { token, fileId: logoId })).toEqual({ content: null });
    expect(await t.query(api.projects.getSharedFile, { token, fileId: other.indexId })).toBeNull();
  });

  test("a revoked, unknown or deleted project's token returns null", async () => {
    const t = convexTest(schema, modules);
    const { projectId, indexId } = await seed(t);
    const token = await alice(t).action(api.projects.createShareLink, { projectId });

    await alice(t).mutation(api.projects.revokeShareLink, { projectId });
    expect(await t.query(api.projects.getShared, { token })).toBeNull();
    expect(await t.query(api.projects.getSharedFile, { token, fileId: indexId })).toBeNull();
    expect(await t.query(api.projects.getShared, { token: "0".repeat(32) })).toBeNull();
    expect(await t.query(api.projects.getShared, { token: "" })).toBeNull();

    const again = await alice(t).action(api.projects.createShareLink, { projectId });
    await t.run((ctx) => ctx.db.patch("projects", projectId, { deletingAt: 1 }));
    expect(await t.query(api.projects.getShared, { token: again })).toBeNull();
  });

  test("remixShared copies the files into the signed-in user's new project", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seed(t);
    const token = await alice(t).action(api.projects.createShareLink, { projectId });

    await expect(t.mutation(api.projects.remixShared, { token })).rejects.toThrow();
    const newId = await bob(t).mutation(api.projects.remixShared, { token });

    const copy = await t.run(async (ctx) => ({
      project: await ctx.db.get("projects", newId),
      files: await ctx.db.query("files").withIndex("by_project", (q) => q.eq("projectId", newId)).collect(),
      envVars: await ctx.db.query("projectEnvVars").withIndex("by_project", (q) => q.eq("projectId", newId)).collect(),
    }));
    expect(copy.project).toMatchObject({ name: "Todo app (imported)", ownerId: BOB });
    expect(copy.project?.shareToken).toBeUndefined();
    expect(copy.project?.instructions).toBeUndefined();
    expect(copy.files.map((f) => f.name).sort()).toEqual(["index.ts", "logo.png", "src"]);
    expect(copy.envVars).toEqual([]);

    await alice(t).mutation(api.projects.revokeShareLink, { projectId });
    await expect(bob(t).mutation(api.projects.remixShared, { token })).rejects.toThrow("Project not found");
  });
});
