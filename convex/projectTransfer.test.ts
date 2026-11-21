// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { Id } from "./_generated/dataModel";
import { api, internal } from "./_generated/api";
import { createCheckpoint } from "./checkpoints";
import { withContents } from "./fileContents";
import schema from "./schema";
import { withoutPrivateFiles } from "./projectTransfer";

const modules = import.meta.glob("./**/*.ts");
const internalKey = "dummy-transfer-key";
const token = "a".repeat(32);
const canary = "CANARY_VALUE_123";
const sealedFields = ["secretRef", "kekProvider", "kekKeyId", "wrappedDek", "ciphertext", "iv", "authTag", "maskedPreview"];

beforeEach(() => {
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", internalKey);
  vi.useFakeTimers();
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async ctx => {
    const projectId = await ctx.db.insert("projects", { name: "Transfer", ownerId: "owner", updatedAt: 0, shareToken: token, envGeneration: 7 });
    const file = async (name: string, content: string, parentId?: Id<"files">) =>
      ctx.db.insert("files", { projectId, name, content, type: "file", updatedAt: 0, parentId });
    await file("index.html", "safe source");
    await file(".env.example", "EXAMPLE=placeholder");
    for (const name of [".env", "nested\\.ENV.local. ", ".npmrc", "server.pem"]) {
      const fileId = await file(name, canary);
      await ctx.db.insert("fileContents", { projectId, fileId, content: canary });
    }
    const storageId = await ctx.storage.store(new Blob([canary]));
    await ctx.db.insert("files", { projectId, name: "client.p12", type: "file", storageId, updatedAt: 0 });
    for (const name of ["node_modules", ".next", "dist", ".git", ".env.local"]) {
      const parent = await ctx.db.insert("files", { projectId, name, type: "folder", updatedAt: 0 });
      await file("runtime.js", canary, parent);
    }
    await ctx.db.insert("projectEnvVars", { projectId, ownerId: "owner", key: "VITE_URL", visibility: "public",
      plainValue: canary, maskedPreview: "MASK_CANARY", source: "manual", updatedAt: 0 });
    await ctx.db.insert("projectEnvVars", { projectId, ownerId: "owner", key: "NEXT_PUBLIC_URL", visibility: "public",
      plainValue: "public URL", maskedPreview: "MASK_CANARY", source: "manual", updatedAt: 0 });
    // Even a secret with a public-looking name is never published.
    await ctx.db.insert("projectEnvVars", { projectId, ownerId: "owner", key: "VITE_SECRET", visibility: "secret",
      secretRef: "REF_CANARY", kekProvider: "dummy", kekKeyId: "KEY_CANARY", wrappedDek: "DEK_CANARY", ciphertext: canary,
      iv: "IV_CANARY", authTag: "TAG_CANARY", maskedPreview: "MASK_CANARY", source: "manual", updatedAt: 0 });
    await ctx.db.insert("projectEnvVars", { projectId, ownerId: "owner", key: "SERVER_URL", visibility: "public",
      plainValue: "SERVER_CANARY", maskedPreview: "MASK_CANARY", source: "manual", updatedAt: 0 });
    const handleId = await ctx.db.insert("runtimeHandles", { projectId, sandboxId: "e2b:dummy", generation: 7, state: "running" });
    const checkpointId = await createCheckpoint(ctx, { projectId, label: "Saved" });
    return { projectId, checkpointId, handleId };
  });
  return { t, owner: t.withIdentity({ subject: "owner" }), ...ids };
}

function expectClean(value: unknown) {
  const json = JSON.stringify(value);
  expect(json).not.toContain(canary);
  for (const field of sealedFields) expect(json).not.toContain(`"${field}"`);
  expect(json).not.toMatch(/MASK_CANARY|SERVER_CANARY|e2b:dummy/);
}

test("ZIP, GitHub export/current push, and checkpoint push return only transferable files", async () => {
  const { t, owner, projectId, checkpointId } = await seed();
  for (const files of [
    await owner.query(api.files.getFilesWithUrls, { projectId }),
    await t.query(api.files.getTransferFiles, { internalKey, projectId }),
    await t.query(api.system.getCheckpointFilesWithUrls, { internalKey, projectId, checkpointId }),
  ]) {
    expectClean(files);
    expect(files.map(f => "path" in f ? f.path : f.name).sort()).toEqual([".env.example", "index.html"]);
  }
  // The raw scan and owner editor still see source secrets, without changing undo.
  expect(JSON.stringify(await t.query(api.system.getProjectFilesWithUrls, { internalKey, projectId }))).toContain(canary);
  await expect(t.query(api.files.getTransferFiles, { internalKey: "wrong", projectId })).rejects.toThrow();
  await expect(t.withIdentity({ subject: "other" }).query(api.files.getFilesWithUrls, { projectId })).rejects.toThrow();
  await expect(t.query(api.files.getFilesWithUrls, { projectId })).rejects.toThrow();
  const otherId = await t.run(ctx => ctx.db.insert("projects", { name: "Other", ownerId: "other", updatedAt: 0 }));
  await expect(t.query(api.system.getCheckpointFilesWithUrls, { internalKey, projectId: otherId, checkpointId })).rejects.toThrow();
});

test.each(["duplicate", "fork", "remixLatest", "remixSnapshot", "showcase"])("%s starts with no env rows or runtime state and drops secret files", async mode => {
  const { t, owner, projectId, checkpointId } = await seed();
  let copyId: Id<"projects">;
  if (mode === "duplicate") copyId = await owner.mutation(api.projects.duplicate, { id: projectId });
  else if (mode === "fork") copyId = await owner.mutation(api.projects.forkFromCheckpoint, { checkpointId });
  else if (mode === "showcase") {
    const showcaseId = await t.run(ctx => ctx.db.insert("showcaseProjects", { projectId, ownerId: "owner", ownerName: "Owner", title: "Transfer",
      description: "Example", techStack: [], designStyle: [], category: "other", status: "published", upvotes: 0, downvotes: 0, viewCount: 0, importCount: 0, publishedAt: 0, updatedAt: 0 }));
    copyId = await t.withIdentity({ subject: "visitor" }).mutation(api.showcase.importToWorkspace, { showcaseProjectId: showcaseId });
  } else {
    if (mode === "remixSnapshot") await owner.mutation(api.projects.configureShare, { projectId, mode: "snapshot", minutes: 0 });
    copyId = await t.withIdentity({ subject: "visitor" }).mutation(api.projects.remixShared, { token });
  }
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const copied = await t.run(async ctx => ({
    project: await ctx.db.get("projects", copyId),
    files: await withContents(ctx, copyId, await ctx.db.query("files").withIndex("by_project", q => q.eq("projectId", copyId)).take(100)),
    env: await ctx.db.query("projectEnvVars").withIndex("by_project", q => q.eq("projectId", copyId)).take(100),
    handles: await ctx.db.query("runtimeHandles").withIndex("by_projectId_and_state", q => q.eq("projectId", copyId)).take(100),
    checkpoints: await ctx.db.query("checkpoints").withIndex("by_project", q => q.eq("projectId", copyId)).take(100),
  }));
  expectClean(copied);
  expect(copied.files.map(f => f.name).sort()).toEqual([".env.example", "index.html"]);
  expect(copied.env).toEqual([]);
  expect(copied.handles).toEqual([]);
  expect(copied.checkpoints).toEqual([]);
  expect(copied.project).not.toHaveProperty("publicPreview");
  expect(copied.project).not.toHaveProperty("envGeneration");
});

test.each(["latest", "snapshot"] as const)("%s share build exposes only public-prefixed plain values, no secret metadata or files", async mode => {
  const { t, owner, projectId } = await seed();
  await owner.mutation(api.projects.configureShare, { projectId, mode, minutes: 0 });
  const manifest = await t.query(api.publicPreviews.manifest, { internalKey, token });
  expect(manifest && { ...manifest, files: [...manifest.files].sort((a, b) => a.path.localeCompare(b.path)) }).toEqual({ files: [
    { path: "index.html", content: "safe source", url: null },
    { path: ".env.example", content: "EXAMPLE=placeholder", url: null },
  ].sort((a, b) => a.path.localeCompare(b.path)), env: { VITE_URL: canary, NEXT_PUBLIC_URL: "public URL" } });
  // Paths sort differently for live rows and checkpoint rows.
  expectClean(manifest?.files);
  for (const field of sealedFields) expect(JSON.stringify(manifest)).not.toContain(`"${field}"`);
  expect(JSON.stringify(manifest)).not.toMatch(/VITE_SECRET|SERVER_CANARY|MASK_CANARY|DEK_CANARY|REF_CANARY/);
  expect(await t.query(api.projects.getShared, { token })).toEqual({ name: "Transfer" });
});

test("checkpoint restore retains secrets only in the same project; subsequent exports stay gated", async () => {
  const { t, owner, projectId, checkpointId } = await seed();
  await owner.mutation(api.checkpoints.restore, { checkpointId });
  const raw = await t.query(api.system.getProjectFilesWithUrls, { internalKey, projectId });
  expect(JSON.stringify(raw)).toContain(canary);
  expectClean(await owner.query(api.files.getFilesWithUrls, { projectId }));
  const saved = await t.run(ctx => ctx.db.query("checkpointFiles").withIndex("by_project", q => q.eq("projectId", projectId)).take(100));
  expect(JSON.stringify(saved)).toContain(canary);
});

test.each(["project", "account"])("%s deletion invalidates runtimes and removes env rows", async mode => {
  const { t, owner, projectId, handleId } = await seed();
  if (mode === "project") await owner.mutation(api.projects.remove, { id: projectId });
  else await t.mutation(internal.users.markDeleted, { clerkUserId: "owner" });
  expect(await t.run(ctx => ctx.db.get("runtimeHandles", handleId))).toMatchObject({ state: "stale" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await t.run(ctx => ctx.db.get("projects", projectId))).toBeNull();
  expect(await t.run(ctx => ctx.db.query("projectEnvVars").withIndex("by_project", q => q.eq("projectId", projectId)).take(100))).toEqual([]);
  // Revocation evidence stays for the sweep until the provider kill succeeds.
  expect(await t.run(ctx => ctx.db.get("runtimeHandles", handleId))).toMatchObject({ state: "stale" });
});

test.each(["node_modules/a.js", "a\\NODE_MODULES. \\cache.js", ".next/cache", ".nuxt/cache", ".output/server.js", ".cache/state", ".turbo/state", ".vercel/state", ".netlify/state", "dist/index.js", "build/server.js", "coverage/results", ".git/config", ".env.local/index.js", "a/.npmrc. "])("excludes private transfer path %s", path => {
  expect(withoutPrivateFiles([{ path, content: canary }])).toEqual([]);
});
