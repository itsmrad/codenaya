// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../../../../convex/_generated/api";
import schema from "../../../../convex/schema";
import { GET, POST } from "@/app/api/public-preview/[token]/route";
import { readPreviewInputs } from "./public-preview";
import { checkRateLimit, resetRateLimits } from "@/lib/rate-limit";

const mocks = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn(), kill: vi.fn(), connect: vi.fn(), create: vi.fn(), after: vi.fn() }));
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
});
afterEach(() => vi.unstubAllEnvs());

async function running(mode: "latest" | "snapshot") {
  const t = convexTest(schema, modules);
  mocks.query.mockImplementation(t.query);
  mocks.mutation.mockImplementation(t.mutation);
  const projectId = await t.run(ctx => ctx.db.insert("projects", { name: "Site", ownerId: "owner", updatedAt: 1, shareToken: token }));
  const owner = t.withIdentity({ subject: "owner" });
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
