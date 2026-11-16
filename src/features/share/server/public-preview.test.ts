// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../../../../convex/_generated/api";
import schema from "../../../../convex/schema";
import { GET, POST } from "@/app/api/public-preview/[token]/route";
import { POST as saveShare } from "@/app/api/share-link/route";
import { bootPreview, readPreviewInputs } from "./public-preview";
import { startProductionSite } from "./production-site";
import { checkRateLimit, resetRateLimits } from "@/lib/rate-limit";

const mocks = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn(), kill: vi.fn(), connect: vi.fn(), create: vi.fn(), after: vi.fn(), auth: vi.fn(), action: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("convex/nextjs", () => ({ fetchAction: mocks.action }));
vi.mock("@/lib/convex-client", () => ({ convex: { query: mocks.query, mutation: mocks.mutation } }));
vi.mock("@/features/sandbox-preview/server/provider/registry", () => ({ createSandbox: mocks.create, getProvider: () => ({ kill: mocks.kill, connect: mocks.connect }) }));
vi.mock("./production-site", () => ({ startProductionSite: vi.fn() }));
vi.mock("next/server", () => ({ after: mocks.after }));
const modules = import.meta.glob("../../../../convex/**/*.ts");
const token = "a".repeat(32);
const key = "preview-test-key";
const context = { params: Promise.resolve({ token }) };
const request = () => new Request(`https://example.com/api/public-preview/${token}`, { method: "POST", headers: { "x-forwarded-for": "203.0.113.9" } });

beforeEach(() => {
  vi.resetAllMocks(); resetRateLimits();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", key);
  mocks.kill.mockResolvedValue(undefined);
  mocks.connect.mockResolvedValue({});
  mocks.auth.mockResolvedValue({ userId: "owner", getToken: async () => "jwt" });
});
afterEach(() => vi.unstubAllEnvs());

async function running(mode: "latest" | "snapshot") {
  const t = convexTest(schema, modules);
  mocks.query.mockImplementation(t.query);
  mocks.mutation.mockImplementation(t.mutation);
  const projectId = await t.run(ctx => ctx.db.insert("projects", { name: "Site", ownerId: "owner", updatedAt: 1, shareToken: token }));
  const owner = t.withIdentity({ subject: "owner" });
  mocks.action.mockImplementation(owner.action);
  const fileId = await owner.mutation(api.files.createFile, { projectId, name: "index.html", content: "A" });
  await owner.mutation(api.projects.configureShare, { projectId, mode, minutes: 0 });
  const inputs = (await readPreviewInputs(token))!;
  await t.mutation(api.publicPreviews.claim, { internalKey: key, token, lease: "old", revision: inputs.revision });
  await t.mutation(api.publicPreviews.update, { internalKey: key, token, lease: "old", sandboxId: "e2b:old", ready: true, url: "https://site.example" });
  mocks.query.mockClear(); mocks.mutation.mockClear();
  return { t, owner, fileId, inputs };
}

test("an ordinary latest save A -> B makes the next visitor schedule a new build without Update link", async () => {
  const { owner, fileId, inputs } = await running("latest");
  await owner.mutation(api.files.updateFile, { id: fileId, content: "B" });
  const response = await POST(request(), context);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "boot" });
  expect(mocks.kill).toHaveBeenCalledWith("old");
  expect(mocks.after).toHaveBeenCalledTimes(1);
  // The callback is deliberately not run: this test never allocates a sandbox.
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.query).toHaveBeenCalledTimes(1);
  const claimArgs = mocks.mutation.mock.calls.map(([, args]) => args);
  expect(claimArgs.some(args => args.revision && args.revision !== inputs.revision)).toBe(true);
});

test.each(["latest", "snapshot"] as const)("unchanged %s inputs attach six times; snapshot edits stay pinned", async mode => {
  const { owner, fileId } = await running(mode);
  if (mode === "snapshot") await owner.mutation(api.files.updateFile, { id: fileId, content: "B" });
  for (let index = 0; index < 6; index++) {
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", url: "https://site.example" });
  }
  expect(mocks.kill).not.toHaveBeenCalled();
  expect(mocks.after).not.toHaveBeenCalled();
  expect(mocks.connect).toHaveBeenCalledTimes(6);
});

test("a latest GET heartbeat reads no manifest even after an ordinary save", async () => {
  const { owner, fileId } = await running("latest");
  await owner.mutation(api.files.updateFile, { id: fileId, content: "B" });
  expect(await (await GET(request(), context)).json()).toEqual({ status: "ready", url: "https://site.example" });
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.kill).not.toHaveBeenCalled();
  expect(mocks.after).not.toHaveBeenCalled();
});


test("a changed latest with exhausted boot allowance leaves the running reservation intact", async () => {
  const { t, owner, fileId } = await running("latest");
  await owner.mutation(api.files.updateFile, { id: fileId, content: "B" });
  for (let index = 0; index < 5; index++) {
    checkRateLimit("203.0.113.9", { scope: "public-preview-start", limit: 5, windowMs: 60_000 });
  }
  expect((await POST(request(), context)).status).toBe(429);
  expect(mocks.kill).not.toHaveBeenCalled();
  expect(mocks.after).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
  const project = await t.run(ctx => ctx.db.query("projects").withIndex("by_shareToken", q => q.eq("shareToken", token)).unique());
  expect(project?.publicPreview).toMatchObject({ lease: "old", sandboxId: "e2b:old", ready: true });
  expect(project?.publicPreview?.desiredRevision).toBeUndefined();
});

test("frame origin configuration changes invalidate an existing warm proxy", async () => {
  const { inputs } = await running("latest");
  vi.stubEnv("CODENAYA_PUBLIC_PREVIEW_ORIGINS", "http://localhost:3100,https://codenaya.tech,http://localhost:3216");
  const refreshed = await readPreviewInputs(token);
  expect(refreshed?.revision).not.toBe(inputs.revision);
  expect(refreshed?.manifest).toEqual(inputs.manifest);
});

test("a failed build stops automatic starts, frees capacity, and retries only on explicit intent", async () => {
  const { t } = await running("latest");
  await t.mutation(api.publicPreviews.update, { internalKey: key, token, lease: "old", release: true });
  mocks.create.mockResolvedValue({ provider: "e2b", id: "failed-build", kill: mocks.kill });
  vi.mocked(startProductionSite).mockRejectedValue(new Error("Build failed"));
  expect(await (await POST(request(), context)).json()).toEqual({ status: "boot" });
  await mocks.after.mock.calls[0][0]();
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.kill).toHaveBeenCalledTimes(1);
  for (let index = 0; index < 3; index++) {
    expect(await (await GET(request(), context)).json()).toEqual({ status: "error" });
    expect(await (await POST(request(), context)).json()).toEqual({ status: "error" });
  }
  expect(mocks.after).toHaveBeenCalledTimes(1);
  // Remembering the error must not consume either owner slot after a confirmed kill.
  for (const char of ["b", "c"]) {
    const otherToken = char.repeat(32);
    await t.run(ctx => ctx.db.insert("projects", { name: char, ownerId: "owner", updatedAt: 1, shareToken: otherToken }));
    expect(await t.mutation(api.publicPreviews.claim, { internalKey: key, token: otherToken, lease: char, revision: "v1" })).toMatchObject({ status: "boot" });
  }
  for (const char of ["b", "c"]) await t.mutation(api.publicPreviews.update, { internalKey: key, token: char.repeat(32), lease: char, release: true });
  const retry = new Request(request(), { body: JSON.stringify({ retry: true }) });
  expect(await (await POST(retry, context)).json()).toEqual({ status: "boot" });
  expect(mocks.after).toHaveBeenCalledTimes(2);
  expect(mocks.create).toHaveBeenCalledTimes(1);
});

test("a failed cleanup reports error but retains the live reservation until its timeout", async () => {
  const { t } = await running("latest");
  await t.mutation(api.publicPreviews.update, { internalKey: key, token, lease: "old", release: true });
  mocks.create.mockResolvedValue({ provider: "e2b", id: "failed-kill", kill: mocks.kill });
  mocks.kill.mockRejectedValue(new Error("Kill failed"));
  vi.mocked(startProductionSite).mockRejectedValue(new Error("Build failed"));
  await POST(request(), context);
  await expect(mocks.after.mock.calls[0][0]()).rejects.toThrow("Kill failed");
  expect(await (await GET(request(), context)).json()).toEqual({ status: "error" });
  const project = await t.run(ctx => ctx.db.query("projects").withIndex("by_shareToken", q => q.eq("shareToken", token)).unique());
  expect(project?.publicPreview).toMatchObject({ sandboxId: "e2b:failed-kill", failed: true });
  expect(project!.publicPreview!.until).toBeGreaterThan(Date.now());
  expect(mocks.create).toHaveBeenCalledTimes(1);
  const retry = () => new Request(request(), { body: JSON.stringify({ retry: true }) });
  expect((await POST(retry(), context)).status).toBe(503);
  const afterRetry = await t.run(ctx => ctx.db.query("projects").withIndex("by_shareToken", q => q.eq("shareToken", token)).unique());
  expect(afterRetry?.publicPreview?.until).toBe(project?.publicPreview?.until);
  expect(mocks.connect).not.toHaveBeenCalled();
  mocks.kill.mockResolvedValue(undefined);
  mocks.create.mockResolvedValue({ provider: "e2b", id: "recovered", kill: mocks.kill });
  vi.mocked(startProductionSite).mockResolvedValue("https://recovered.example");
  expect(await (await POST(retry(), context)).json()).toEqual({ status: "boot" });
  expect(mocks.after).toHaveBeenCalledTimes(2);
  await mocks.after.mock.calls[1][0]();
  expect(mocks.create).toHaveBeenCalledTimes(2);
  expect(await (await GET(request(), context)).json()).toEqual({ status: "ready", url: "https://recovered.example" });
});

test("an on-demand owner publication recovers a failed snapshot with the newly saved version", async () => {
  const { t, owner, fileId } = await running("snapshot");
  const projectId = await t.run(async ctx => (await ctx.db.get("files", fileId))!.projectId);
  await t.mutation(api.publicPreviews.update, { internalKey: key, token, lease: "old", release: true });
  mocks.create.mockResolvedValue({ provider: "e2b", id: "failed-A", kill: mocks.kill });
  vi.mocked(startProductionSite).mockRejectedValue(new Error("Build failed"));
  await POST(request(), context);
  await mocks.after.mock.calls[0][0]();
  expect(await (await GET(request(), context)).json()).toEqual({ status: "error" });
  await owner.mutation(api.files.updateFile, { id: fileId, content: "B" });
  mocks.create.mockResolvedValue({ provider: "e2b", id: "fixed-B", kill: mocks.kill });
  vi.mocked(startProductionSite).mockResolvedValue("https://fixed.example");
  const response = await saveShare(new Request("https://example.com/api/share-link", { method: "POST",
    body: JSON.stringify({ projectId, mode: "snapshot", minutes: 0, updateSnapshot: true }),
  }));
  expect(await response.json()).toEqual({ status: "boot" });
  await mocks.after.mock.calls[1][0]();
  expect(vi.mocked(startProductionSite).mock.calls.at(-1)![1]).toEqual([{ path: "index.html", data: "B" }]);
  expect(await (await POST(request(), context)).json()).toEqual({ status: "ready", url: "https://fixed.example" });
});
