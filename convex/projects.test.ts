// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id, TableNames } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const ALICE = "user_alice";
const BOB = "user_bob";

/** Every table that holds rows belonging to a project. */
const PROJECT_TABLES = [
  "files",
  "conversations",
  "messages",
  "projectEnvVars",
  "skills",
  "projectSkillSettings",
  "showcaseProjects",
] as const satisfies TableNames[];

function setup() {
  const t = convexTest(schema, modules);
  return {
    t,
    alice: t.withIdentity({ subject: ALICE }),
    bob: t.withIdentity({ subject: BOB }),
  };
}

type T = ReturnType<typeof convexTest>;

/** A project with a nested file tree, a binary file, chat, env vars, skills and a showcase entry. */
async function seedProject(t: T, ownerId: string, extraFiles = 0) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const projectId = await ctx.db.insert("projects", {
      name: "Todo app",
      ownerId,
      updatedAt: now,
      settings: { devCommand: "npm run dev" },
    });
    const srcId = await ctx.db.insert("files", {
      projectId,
      name: "src",
      type: "folder",
      updatedAt: now,
    });
    await ctx.db.insert("files", {
      projectId,
      parentId: srcId,
      name: "index.ts",
      type: "file",
      content: "export {};",
      updatedAt: now,
    });
    for (let i = 0; i < extraFiles; i++) {
      await ctx.db.insert("files", {
        projectId,
        name: `file-${i}.ts`,
        type: "file",
        content: "x",
        updatedAt: now,
      });
    }
    const storageId = await ctx.storage.store(new Blob(["png"]));
    await ctx.db.insert("files", {
      projectId,
      name: "logo.png",
      type: "file",
      storageId,
      updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      projectId,
      title: "Chat",
      updatedAt: now,
    });
    await ctx.db.insert("messages", {
      conversationId,
      projectId,
      role: "user",
      content: "hi",
    });
    await ctx.db.insert("projectEnvVars", {
      projectId,
      ownerId,
      key: "PUBLIC_URL",
      visibility: "public",
      plainValue: "https://example.com",
      maskedPreview: "https://…",
      source: "manual",
      updatedAt: now,
    });
    await ctx.db.insert("projectEnvVars", {
      projectId,
      ownerId,
      key: "API_SECRET",
      visibility: "secret",
      secretRef: "ref",
      kekProvider: "local",
      kekKeyId: "k1",
      wrappedDek: "dek",
      ciphertext: "ct",
      iv: "iv",
      authTag: "tag",
      maskedPreview: "••••",
      source: "manual",
      updatedAt: now,
    });
    const projectSkillId = await ctx.db.insert("skills", {
      ownerId,
      projectId,
      name: "local-skill",
      description: "Project only",
      body: "Steps",
      source: "user",
      updatedAt: now,
    });
    await ctx.db.insert("projectSkillSettings", {
      projectId,
      ownerId,
      skillKey: `user:${projectSkillId}`,
      enabled: true,
      updatedAt: now,
    });
    await ctx.db.insert("projectSkillSettings", {
      projectId,
      ownerId,
      skillKey: "builtin:frontend-design",
      enabled: false,
      updatedAt: now,
    });
    await ctx.db.insert("showcaseProjects", {
      projectId,
      ownerId,
      ownerName: ownerId,
      title: "Demo",
      description: "Demo",
      techStack: [],
      designStyle: [],
      category: "web",
      upvotes: 0,
      downvotes: 0,
      viewCount: 0,
      importCount: 0,
      status: "published",
      publishedAt: now,
      updatedAt: now,
    });
    return { projectId, storageId };
  });
}

const rowsOf = (t: T, table: (typeof PROJECT_TABLES)[number], projectId: Id<"projects">) =>
  t.run(async (ctx) =>
    (await ctx.db.query(table).collect()).filter((row) => row.projectId === projectId),
  );

describe("projects", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("refuses another user's project for rename, duplicate and remove", async () => {
    const { t, bob } = setup();
    const { projectId } = await seedProject(t, ALICE);

    await expect(
      bob.mutation(api.projects.rename, { id: projectId, name: "Mine" }),
    ).rejects.toThrow(/Unauthorized/);
    await expect(bob.mutation(api.projects.duplicate, { id: projectId })).rejects.toThrow(
      /Unauthorized/,
    );
    await expect(bob.mutation(api.projects.remove, { id: projectId })).rejects.toThrow(
      /Unauthorized/,
    );

    const project = await t.run((ctx) => ctx.db.get("projects", projectId));
    expect(project).toMatchObject({ name: "Todo app" });
    expect(project?.deletingAt).toBeUndefined();
  });

  test("rename trims and validates the name", async () => {
    const { t, alice } = setup();
    const { projectId } = await seedProject(t, ALICE);

    await expect(
      alice.mutation(api.projects.rename, { id: projectId, name: "   " }),
    ).rejects.toThrow(/empty/);
    await expect(
      alice.mutation(api.projects.rename, { id: projectId, name: "a".repeat(101) }),
    ).rejects.toThrow(/at most/);

    await alice.mutation(api.projects.rename, { id: projectId, name: "  Shop  " });
    expect(await alice.query(api.projects.getById, { id: projectId })).toMatchObject({
      name: "Shop",
    });
  });

  test("duplicate copies files, skills and public env vars but not secrets or chat", async () => {
    vi.useFakeTimers();
    const { t, alice } = setup();
    const { projectId, storageId } = await seedProject(t, ALICE);

    const copyId = await alice.mutation(api.projects.duplicate, { id: projectId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await alice.query(api.projects.getById, { id: copyId })).toMatchObject({
      name: "Todo app (copy)",
      ownerId: ALICE,
      settings: { devCommand: "npm run dev" },
    });

    // Same tree, with the parent link pointing inside the copy.
    const files = await rowsOf(t, "files", copyId);
    expect(files.map((f) => f.name).sort()).toEqual(["index.ts", "logo.png", "src"]);
    const src = files.find((f) => f.name === "src");
    expect(files.find((f) => f.name === "index.ts")?.parentId).toBe(src?._id);

    // The binary file got its own blob, so deleting the original can't break it.
    const logo = files.find((f) => f.name === "logo.png");
    expect(logo?.storageId).toBeDefined();
    expect(logo?.storageId).not.toBe(storageId);

    const envVars = await rowsOf(t, "projectEnvVars", copyId);
    expect(envVars.map((e) => e.key)).toEqual(["PUBLIC_URL"]);

    const [copiedSkill] = await rowsOf(t, "skills", copyId);
    expect(copiedSkill).toMatchObject({ name: "local-skill" });
    const settings = await rowsOf(t, "projectSkillSettings", copyId);
    expect(settings.map((s) => s.skillKey).sort()).toEqual(
      ["builtin:frontend-design", `user:${copiedSkill._id}`].sort(),
    );

    expect(await rowsOf(t, "conversations", copyId)).toHaveLength(0);
    expect(await rowsOf(t, "messages", copyId)).toHaveLength(0);
    expect(await rowsOf(t, "showcaseProjects", copyId)).toHaveLength(0);
  });

  test("remove hides the project at once, then deletes every child row and blob", async () => {
    vi.useFakeTimers();
    const { t, alice } = setup();
    // More files than one cascade batch, so the deletion has to reschedule itself.
    const doomed = await seedProject(t, ALICE, 150);
    const kept = await seedProject(t, ALICE);

    await alice.mutation(api.projects.remove, { id: doomed.projectId });

    // Hidden before the cascade runs.
    expect((await alice.query(api.projects.get, {})).map((p) => p._id)).toEqual([
      kept.projectId,
    ]);
    await expect(
      alice.query(api.projects.getById, { id: doomed.projectId }),
    ).rejects.toThrow(/not found/);
    await expect(
      alice.mutation(api.projects.duplicate, { id: doomed.projectId }),
    ).rejects.toThrow(/not found/);

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.run((ctx) => ctx.db.get("projects", doomed.projectId))).toBeNull();
    for (const table of PROJECT_TABLES) {
      expect(await rowsOf(t, table, doomed.projectId)).toHaveLength(0);
      expect((await rowsOf(t, table, kept.projectId)).length).toBeGreaterThan(0);
    }
    expect(await t.run((ctx) => ctx.db.system.get(doomed.storageId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.system.get(kept.storageId))).not.toBeNull();
  });

  test("deleting the original leaves a duplicate's files intact", async () => {
    vi.useFakeTimers();
    const { t, alice } = setup();
    const { projectId } = await seedProject(t, ALICE);

    const copyId = await alice.mutation(api.projects.duplicate, { id: projectId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await alice.mutation(api.projects.remove, { id: projectId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const logo = (await rowsOf(t, "files", copyId)).find((f) => f.name === "logo.png");
    expect(await t.run((ctx) => ctx.db.system.get(logo!.storageId!))).not.toBeNull();
  });
});
