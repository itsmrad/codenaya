// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { PREVIEW_IDLE_MS } from "../src/features/share/preview-policy";

const modules = import.meta.glob("./**/*.ts");
const internalKey = "preview-test-key";
const token = "a".repeat(32);
const args = { internalKey, token, lease: "first", revision: "v1" };
async function seed() {
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", internalKey);
  const t = convexTest(schema, modules);
  const id = await t.run(ctx => ctx.db.insert("projects", { ownerId: "owner", name: "Site", updatedAt: 1, shareToken: token }));
  return { t, id };
}
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

test.each(["credentials", "ordinary"])("latest manifests omit logically deleted %s subtrees before cleanup", async name => {
  const { t, id } = await seed();
  const { folder, descendant } = await t.run(async ctx => {
    await ctx.db.insert("files", { projectId: id, name: "index.html", type: "file", content: "safe", updatedAt: 1 });
    const folder = await ctx.db.insert("files", { projectId: id, name, type: "folder", updatedAt: 1 });
    const child = await ctx.db.insert("files", { projectId: id, parentId: folder, name: "public", type: "folder", updatedAt: 1 });
    const descendant = await ctx.db.insert("files", { projectId: id, parentId: child, name: "config.json", type: "file", content: "private", updatedAt: 1 });
    return { folder, descendant };
  });
  await t.withIdentity({ subject: "owner" }).mutation(api.files.deleteFile, { id: folder });
  expect(await t.run(ctx => ctx.db.get("files", descendant))).not.toBeNull();
  expect((await t.query(api.publicPreviews.manifest, { internalKey, token }))?.files).toEqual([
    { path: "index.html", content: "safe", url: null },
  ]);
});

describe("public preview reservations", () => {
  test("parallel starts claim a single lease, attach to one sandbox, and reject stale writes", async () => {
    const { t } = await seed();
    const results = await Promise.all([t.mutation(api.publicPreviews.claim, args), t.mutation(api.publicPreviews.claim, { ...args, lease: "second" })]);
    expect(results.map(row => row.status).sort()).toEqual(["boot", "wait"]);
    const lease = results.find(row => row.status === "boot")!.lease!;
    expect(await t.mutation(api.publicPreviews.update, { internalKey, token, lease: "wrong", ready: true })).toBeNull();
    await t.mutation(api.publicPreviews.update, { internalKey, token, lease, sandboxId: "e2b:one", url: "https://site.example", ready: true });
    expect(await t.mutation(api.publicPreviews.claim, args)).toMatchObject({ status: "ready", sandboxId: "e2b:one", lease });
  });

  test("two per owner across different links; expired reservations free capacity", async () => {
    const { t } = await seed();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    for (const char of ["b", "c"]) await t.run(ctx => ctx.db.insert("projects", { ownerId: "owner", name: char, updatedAt: 1, shareToken: char.repeat(32) }));
    await t.mutation(api.publicPreviews.claim, args);
    await t.mutation(api.publicPreviews.claim, { ...args, token: "b".repeat(32) });
    expect(await t.mutation(api.publicPreviews.claim, { ...args, token: "c".repeat(32) })).toEqual({ status: "busy" });
    vi.mocked(Date.now).mockReturnValue(now + PREVIEW_IDLE_MS + 1);
    expect(await t.mutation(api.publicPreviews.claim, { ...args, token: "c".repeat(32) })).toMatchObject({ status: "boot" });
  });

  test("501 idle projects do not consume capacity; later active reservations still enforce the cap", async () => {
    const { t } = await seed();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    await t.run(async ctx => {
      for (let index = 0; index < 500; index++) {
        await ctx.db.insert("projects", { ownerId: "owner", name: `Idle ${index}`, updatedAt: 1 });
      }
    });
    expect(await t.mutation(api.publicPreviews.claim, args)).toMatchObject({ status: "boot" });
    await t.mutation(api.publicPreviews.update, { internalKey, token, lease: "first", release: true });
    // Reservations beyond the old 501-row cutoff must still count, including tombstones.
    await t.run(async ctx => {
      for (const offset of [1, 2]) {
        await ctx.db.insert("projects", { ownerId: "owner", name: `Active ${offset}`, updatedAt: 1,
          deletingAt: now, publicPreview: { lease: `late-${offset}`, revision: "v1", ready: false, until: now + offset * 60_000 } });
      }
    });
    expect(await t.mutation(api.publicPreviews.claim, args)).toEqual({ status: "busy" });
    vi.mocked(Date.now).mockReturnValue(now + 60_000);
    expect(await t.mutation(api.publicPreviews.claim, args)).toMatchObject({ status: "boot" });
  });

  test("heartbeat deadline respects idle and keep-live; only changed revisions retire", async () => {
    const { t, id } = await seed();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    await t.run(ctx => ctx.db.patch("projects", id, { shareKeepLiveUntil: now + 3_600_000 }));
    const state = await t.mutation(api.publicPreviews.claim, args);
    expect(state.until).toBe(now + 3_600_000);
    await t.mutation(api.publicPreviews.update, { internalKey, token, lease: "first", sandboxId: "e2b:one", ready: true });
    expect(await t.mutation(api.publicPreviews.claim, args)).toMatchObject({ status: "ready" });
    expect(await t.mutation(api.publicPreviews.claim, { ...args, revision: "v2" })).toMatchObject({ status: "retire", lease: "first" });
    expect(await t.mutation(api.publicPreviews.update, { internalKey, token, lease: "first", heartbeat: true })).toBe(now + 3_600_000);
    await t.run(ctx => ctx.db.patch("projects", id, { shareKeepLiveUntil: undefined }));
    expect(await t.mutation(api.publicPreviews.update, { internalKey, token, lease: "first", heartbeat: true })).toBe(now + PREVIEW_IDLE_MS);
  });

  test("missing, malformed, disabled and deleting links cannot boot, and internal key is enforced", async () => {
    const { t, id } = await seed();
    await expect(t.mutation(api.publicPreviews.claim, { ...args, internalKey: "wrong" })).rejects.toThrow();
    expect(await t.mutation(api.publicPreviews.claim, { ...args, token: "../bad" })).toEqual({ status: "missing" });
    await t.withIdentity({ subject: "owner" }).mutation(api.projects.revokeShareLink, { projectId: id });
    expect(await t.mutation(api.publicPreviews.claim, args)).toEqual({ status: "missing" });
  });
});

test("snapshot Remix copies the shared version; private files and env vars never enter the manifest", async () => {
  const { t, id } = await seed();
  const fileId = await t.run(async ctx => {
    const fileId = await ctx.db.insert("files", { projectId: id, name: "index.html", type: "file", updatedAt: 1, content: "snapshot" });
    await ctx.db.insert("files", { projectId: id, name: ".env.local", type: "file", updatedAt: 1, content: "SECRET" });
    for (const key of ["VITE_URL", "NEXT_PUBLIC_URL", "PRIVATE_URL"]) await ctx.db.insert("projectEnvVars", { projectId: id, ownerId: "owner", key, visibility: "public", plainValue: "value", maskedPreview: "value", source: "manual", updatedAt: 1 });
    return fileId;
  });
  const owner = t.withIdentity({ subject: "owner" });
  await expect(t.withIdentity({ subject: "other" }).mutation(api.projects.configureShare, { projectId: id, mode: "snapshot", minutes: 0 })).rejects.toThrow();
  await owner.mutation(api.projects.configureShare, { projectId: id, mode: "snapshot", minutes: 0 });
  await t.run(ctx => ctx.db.patch("files", fileId, { content: "new version" }));
  const manifest = await t.query(api.publicPreviews.manifest, { internalKey, token });
  expect(manifest).toMatchObject({ files: [{ path: "index.html", content: "snapshot" }], env: { VITE_URL: "value", NEXT_PUBLIC_URL: "value" } });
  expect(JSON.stringify(manifest)).not.toMatch(/SECRET|PRIVATE_URL/);
  const remixId = await t.withIdentity({ subject: "visitor" }).mutation(api.projects.remixShared, { token });
  const copied = await t.run(ctx => ctx.db.query("fileContents").withIndex("by_project", q => q.eq("projectId", remixId)).take(10));
  expect(copied.map(file => file.content)).toEqual(["snapshot"]);
  await owner.mutation(api.projects.configureShare, { projectId: id, mode: "snapshot", minutes: 0, updateSnapshot: true });
  expect((await t.query(api.publicPreviews.manifest, { internalKey, token }))?.files[0].content).toBe("new version");
});

test("updates requested during a boot retire only after the sandbox is attached", async () => {
  const { t } = await seed();
  await t.mutation(api.publicPreviews.claim, args);
  expect(await t.mutation(api.publicPreviews.claim, { ...args, revision: "new" })).toMatchObject({ status: "wait" });
  await t.mutation(api.publicPreviews.update, { internalKey, token, lease: "first", sandboxId: "e2b:old" });
  const { revision: _revision, ...poll } = args;
  expect(await t.mutation(api.publicPreviews.claim, poll)).toMatchObject({ status: "retire", sandboxId: "e2b:old" });
});

test("deleting a project retains its capacity reservation until the sandbox expires", async () => {
  const { t, id } = await seed();
  await t.mutation(api.publicPreviews.claim, args);
  const { deleteProjectBatch } = await import("./projectCascade");
  await t.run(async ctx => {
    await ctx.db.patch("projects", id, { deletingAt: Date.now() });
    expect(await deleteProjectBatch(ctx, id)).toBe(false);
    expect(await ctx.db.get("projects", id)).not.toBeNull();
  });
});

test("replacing snapshots releases the old checkpoint; disabling retains the shared version", async () => {
  const { t, id } = await seed();
  const owner = t.withIdentity({ subject: "owner" });
  const options = { projectId: id, mode: "snapshot" as const, minutes: 0 as const };
  await owner.mutation(api.projects.configureShare, options);
  const old = await t.run(async ctx => (await ctx.db.get("projects", id))!.shareCheckpointId!);
  await owner.mutation(api.projects.configureShare, { ...options, updateSnapshot: true });
  expect(await t.run(ctx => ctx.db.get("checkpoints", old))).toBeNull();
  const next = await t.run(async ctx => (await ctx.db.get("projects", id))!.shareCheckpointId!);
  await owner.mutation(api.projects.revokeShareLink, { projectId: id });
  expect(await t.run(ctx => ctx.db.get("checkpoints", next))).not.toBeNull();
  expect(await t.query(api.projects.getShared, { token })).toBeNull();
  expect(await owner.action(api.projects.createShareLink, { projectId: id })).toBe(token);
  expect(await t.query(api.projects.getShared, { token })).not.toBeNull();
});

test("Generate/Update preserves the slug, snapshot and running lease for lifetime-only changes", async () => {
  const { t, id } = await seed();
  const owner = t.withIdentity({ subject: "owner" });
  const options = { mode: "snapshot" as const, minutes: 0 as const };
  expect(await owner.action(api.projects.createShareLink, { projectId: id, options })).toBe(token);
  const checkpoint = await t.run(async ctx => (await ctx.db.get("projects", id))!.shareCheckpointId);
  await t.mutation(api.publicPreviews.claim, args);
  await t.mutation(api.publicPreviews.update, { internalKey, token, lease: "first", sandboxId: "e2b:one", ready: true });
  expect(await owner.action(api.projects.createShareLink, { projectId: id, options: { ...options, minutes: 30 } })).toBe(token);
  expect(await t.run(async ctx => (await ctx.db.get("projects", id))!.shareCheckpointId)).toBe(checkpoint);
  expect(await t.mutation(api.publicPreviews.claim, args)).toMatchObject({ status: "ready", sandboxId: "e2b:one", lease: "first" });
});
