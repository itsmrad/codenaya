// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id, TableNames } from "./_generated/dataModel";
import { deleteProjectBatch } from "./projectCascade";
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

/** Runs a project's whole deletion cascade now, ahead of any scheduled work. */
const deleteProjectNow = (t: T, projectId: Id<"projects">) =>
  t.run(async (ctx) => {
    while (!(await deleteProjectBatch(ctx, projectId)));
  });

const blobExists = async (t: T, storageId: Id<"_storage">) =>
  (await t.run((ctx) => ctx.db.system.get(storageId))) !== null;

const logoOf = async (t: T, projectId: Id<"projects">) =>
  (await rowsOf(t, "files", projectId)).find((f) => f.name === "logo.png")!;

// #221: a copy shares the source's blobs until copyBlobs has run.
describe("copied projects never delete the source's blobs", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("another user's showcase import, deleted before copyBlobs runs", async () => {
    // Fake timers keep the scheduled copyBlobs from running until we say so.
    vi.useFakeTimers();
    const { t, bob } = setup();
    const { projectId, storageId } = await seedProject(t, ALICE);
    const showcase = (await rowsOf(t, "showcaseProjects", projectId))[0];

    const importId = await bob.mutation(api.showcase.importToWorkspace, {
      showcaseProjectId: showcase._id,
    });
    const imported = await logoOf(t, importId);
    expect(imported.storageId).toBe(storageId);

    await bob.mutation(api.files.deleteFile, { id: imported._id });
    expect(await blobExists(t, storageId)).toBe(true);

    await deleteProjectNow(t, importId);
    expect(await blobExists(t, storageId)).toBe(true);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await logoOf(t, projectId)).storageId).toBe(storageId);
    expect(await blobExists(t, storageId)).toBe(true);
  });

  test("a duplicate, deleted before copyBlobs runs", async () => {
    vi.useFakeTimers();
    const { t, alice } = setup();
    const { projectId, storageId } = await seedProject(t, ALICE);

    const copyId = await alice.mutation(api.projects.duplicate, { id: projectId });
    await alice.mutation(api.files.deleteFile, { id: (await logoOf(t, copyId))._id });
    await deleteProjectNow(t, copyId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await blobExists(t, storageId)).toBe(true);
  });

  test("deleting the source before copyBlobs runs keeps the copy's blob, then frees the old one", async () => {
    vi.useFakeTimers();
    const { t, alice } = setup();
    const { projectId, storageId } = await seedProject(t, ALICE);

    const copyId = await alice.mutation(api.projects.duplicate, { id: projectId });
    await deleteProjectNow(t, projectId);
    expect(await blobExists(t, storageId)).toBe(true);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const logo = await logoOf(t, copyId);
    expect(logo.storageId).not.toBe(storageId);
    expect(await blobExists(t, logo.storageId!)).toBe(true);
    // Nothing references the old blob any more, so it is not leaked.
    expect(await blobExists(t, storageId)).toBe(false);
  });

  test("the last reference to a shared blob frees it", async () => {
    vi.useFakeTimers();
    const { t, alice } = setup();
    const { projectId, storageId } = await seedProject(t, ALICE);

    const copyId = await alice.mutation(api.projects.duplicate, { id: projectId });
    await alice.mutation(api.files.deleteFile, { id: (await logoOf(t, copyId))._id });
    expect(await blobExists(t, storageId)).toBe(true);
    await alice.mutation(api.files.deleteFile, { id: (await logoOf(t, projectId))._id });
    expect(await blobExists(t, storageId)).toBe(false);
  });

  test("other users can't delete the publisher's files", async () => {
    const { t, bob } = setup();
    const { projectId, storageId } = await seedProject(t, ALICE);

    await expect(
      bob.mutation(api.files.deleteFile, { id: (await logoOf(t, projectId))._id }),
    ).rejects.toThrow(/Unauthorized/);
    expect(await blobExists(t, storageId)).toBe(true);
  });
});

describe("project-scoped public mutations", () => {
  test("refuse a project that is being deleted (#239)", async () => {
    const t = convexTest(schema, modules);
    const projectId = await t.run((ctx) =>
      ctx.db.insert("projects", { name: "Gone", ownerId: ALICE, updatedAt: 0, deletingAt: 1 })
    );
    const alice = t.withIdentity({ subject: ALICE });

    for (const write of [
      () => alice.mutation(api.projects.updateSettings, { id: projectId, settings: {} }),
      () => alice.mutation(api.conversations.create, { projectId, title: "Chat" }),
      () => alice.mutation(api.chatImages.generateUploadUrl, { projectId }),
      () => alice.mutation(api.envVars.setPublicEnvVar, { projectId, key: "NEXT_PUBLIC_A", value: "1" }),
      () => alice.mutation(api.skills.setAllProjectSkillsEnabled, { projectId, enabled: true }),
      () =>
        alice.mutation(api.showcase.publish, {
          projectId,
          title: "Gone",
          description: "",
          techStack: [],
          designStyle: [],
          category: "tool",
        }),
    ]) {
      await expect(write()).rejects.toThrow("Project not found");
    }
  });
});

describe("typed project errors (#266)", () => {
  test("missing and foreign projects throw codes the project page can branch on", async () => {
    const { t, alice, bob } = setup();
    const projectId = await t.run((ctx) =>
      ctx.db.insert("projects", { name: "p", ownerId: ALICE, updatedAt: 0 })
    );

    await expect(bob.query(api.projects.getById, { id: projectId })).rejects.toEqual(
      expect.objectContaining({ data: expect.objectContaining({ code: "FORBIDDEN" }) })
    );
    await alice.mutation(api.projects.remove, { id: projectId });
    await expect(alice.query(api.projects.getById, { id: projectId })).rejects.toEqual(
      expect.objectContaining({ data: expect.objectContaining({ code: "NOT_FOUND" }) })
    );
  });

  test("createFile returns the new file's id, so the explorer can open it", async () => {
    const { t, alice } = setup();
    const projectId = await t.run((ctx) =>
      ctx.db.insert("projects", { name: "p", ownerId: ALICE, updatedAt: 0 })
    );
    const fileId = await alice.mutation(api.files.createFile, {
      projectId,
      name: "quick.ts",
      content: "",
    });
    expect((await alice.query(api.files.getFile, { id: fileId })).name).toBe("quick.ts");
  });
});

// A client-supplied limit is clamped to 1-50 (#212).
test("getPartial clamps its limit", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    for (let i = 0; i < 60; i++) {
      await ctx.db.insert("projects", { name: `p${i}`, ownerId: ALICE, updatedAt: i });
    }
  });
  const alice = t.withIdentity({ subject: ALICE });

  expect(await alice.query(api.projects.getPartial, { limit: 1000 })).toHaveLength(50);
  expect(await alice.query(api.projects.getPartial, { limit: -5 })).toHaveLength(1);
});

describe("projects.conversationNeedsFirstBuildForServer (Auto routing, #322)", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("is true until the project's first build: seeded and pending, or empty", async () => {
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
    const t = convexTest(schema, modules);
    const conversations = await t.run(async (ctx) => {
      const project = async (fields: { files: boolean; firstBuildPending?: boolean }) => {
        const projectId = await ctx.db.insert("projects", {
          name: "p",
          ownerId: ALICE,
          updatedAt: 0,
          ...(fields.firstBuildPending ? { firstBuildPending: true } : {}),
        });
        if (fields.files) {
          await ctx.db.insert("files", { projectId, name: "package.json", type: "file", content: "{}", updatedAt: 0 });
        }
        return await ctx.db.insert("conversations", { projectId, title: "c", updatedAt: 0 });
      };
      return {
        empty: await project({ files: false }),
        seeded: await project({ files: true, firstBuildPending: true }),
        built: await project({ files: true }),
      };
    });
    const needsFirstBuild = (conversationId: Id<"conversations">, internalKey = "ik") =>
      t.query(api.projects.conversationNeedsFirstBuildForServer, { internalKey, conversationId });

    expect(await needsFirstBuild(conversations.empty)).toBe(true);
    // A seeded starter whose first run didn't finish (#338) still needs its build.
    expect(await needsFirstBuild(conversations.seeded)).toBe(true);
    expect(await needsFirstBuild(conversations.built)).toBe(false);
    await expect(needsFirstBuild(conversations.built, "wrong")).rejects.toThrow();
  });
});
