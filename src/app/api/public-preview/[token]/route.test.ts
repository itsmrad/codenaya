import { beforeEach, expect, test, vi } from "vitest";
import { resetRateLimits } from "@/lib/rate-limit";

const mocks = vi.hoisted(() => ({ after: vi.fn(), boot: vi.fn(), heartbeat: vi.fn(), prepare: vi.fn(), state: vi.fn(), inputs: vi.fn() }));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/features/share/server/public-preview", () => ({ bootPreview: mocks.boot, heartbeatPreview: mocks.heartbeat, preparePreview: mocks.prepare, previewState: mocks.state, readPreviewInputs: mocks.inputs }));
import { GET, POST } from "./route";
const token = "a".repeat(32);
const context = { params: Promise.resolve({ token }) };
const request = () => new Request(`https://example.com/api/public-preview/${token}`, { method: "POST", headers: { "x-forwarded-for": "203.0.113.5" } });

beforeEach(() => { vi.resetAllMocks(); resetRateLimits(); mocks.state.mockResolvedValue({ status: "boot" }); mocks.inputs.mockResolvedValue({ revision: "v1", manifest: { files: [], env: {} } }); });

test("malformed and disabled links are 404", async () => {
  expect((await POST(request(), { params: Promise.resolve({ token: "bad" }) })).status).toBe(404);
  expect(mocks.prepare).not.toHaveBeenCalled();
  mocks.prepare.mockResolvedValue({ state: { status: "missing" } });
  expect((await POST(request(), context)).status).toBe(404);
});

test("a light heartbeat attaches without reading build inputs or scheduling a boot", async () => {
  mocks.state.mockResolvedValue({ status: "ready", sandboxId: "e2b:one", lease: "private-lease", revision: "private-revision" });
  mocks.heartbeat.mockResolvedValue({ status: "ready", url: "https://site.example", sandboxId: "e2b:one", lease: "private-lease" });
  const response = await GET(request(), context);
  expect(await response.json()).toEqual({ status: "ready", url: "https://site.example" });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.inputs).not.toHaveBeenCalled();
  expect(mocks.after).not.toHaveBeenCalled();
});

test("starting is rate limited per IP before loading the manifest", async () => {
  mocks.prepare.mockResolvedValue({ state: { status: "wait" } });
  for (let n = 0; n < 5; n++) expect((await POST(request(), context)).status).toBe(200);
  const response = await POST(request(), context);
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBeTruthy();
  expect(mocks.prepare).toHaveBeenCalledTimes(5);
  expect(mocks.inputs).not.toHaveBeenCalled();
});

test("a reserved cold start schedules exactly one boot callback", async () => {
  mocks.prepare.mockResolvedValue({ state: { status: "boot", lease: "one" }, manifest: { files: [], env: {} } });
  expect(await (await POST(request(), context)).json()).toEqual({ status: "boot" });
  expect(mocks.after).toHaveBeenCalledTimes(1);
  expect(mocks.boot).not.toHaveBeenCalled();
  await mocks.after.mock.calls[0][0]();
  expect(mocks.boot).toHaveBeenCalledTimes(1);
});


test("ready previews attach even after this IP exhausts its boot allowance", async () => {
  mocks.prepare.mockResolvedValue({ state: { status: "wait" } });
  for (let n = 0; n < 5; n++) await POST(request(), context);
  expect((await POST(request(), context)).status).toBe(429);
  const ready = { status: "ready", sandboxId: "e2b:one", lease: "one", revision: "v1", url: "https://site.example" };
  mocks.state.mockResolvedValue(ready);
  mocks.heartbeat.mockResolvedValue(ready);
  for (let n = 0; n < 6; n++) {
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", url: "https://site.example" });
  }
  expect(mocks.prepare).toHaveBeenCalledTimes(5);
  expect(mocks.heartbeat).toHaveBeenCalledTimes(6);
});

test("an in-progress boot waits and a genuine cap returns busy without rate limiting", async () => {
  mocks.prepare.mockResolvedValue({ state: { status: "wait" } });
  for (let n = 0; n < 5; n++) await POST(request(), context);
  for (const status of ["wait", "busy"]) {
    mocks.state.mockResolvedValue({ status, revision: "v1" });
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status });
  }
});

test("an expired provider sandbox still needs boot allowance", async () => {
  mocks.prepare.mockResolvedValue({ state: { status: "wait" } });
  for (let n = 0; n < 5; n++) await POST(request(), context);
  mocks.state.mockResolvedValue({ status: "ready", sandboxId: "e2b:gone", lease: "one", revision: "v1" });
  mocks.heartbeat.mockResolvedValue({ status: "boot" });
  expect((await POST(request(), context)).status).toBe(429);
  expect(mocks.prepare).toHaveBeenCalledTimes(5);
});


test.each(["ready", "wait"])("changed saved inputs in %s pass preloaded inputs only after the limiter", async status => {
  mocks.state.mockResolvedValue({ status, revision: "v1", sandboxId: "e2b:old" });
  const inputs = { revision: "v2", manifest: { files: [], env: {} } };
  mocks.inputs.mockResolvedValue(inputs);
  mocks.prepare.mockResolvedValue({ state: { status: "boot" }, manifest: inputs.manifest });
  expect(await (await POST(request(), context)).json()).toEqual({ status: "boot" });
  expect(mocks.prepare).toHaveBeenCalledWith(token, inputs);
  expect(mocks.inputs).toHaveBeenCalledTimes(1);
  expect(mocks.heartbeat).not.toHaveBeenCalled();
});

test("changed inputs with an exhausted IP budget never prepare or retire the preview", async () => {
  mocks.prepare.mockResolvedValue({ state: { status: "wait" } });
  for (let n = 0; n < 5; n++) await POST(request(), context);
  mocks.prepare.mockClear();
  mocks.state.mockResolvedValue({ status: "ready", revision: "v1", sandboxId: "e2b:old" });
  mocks.inputs.mockResolvedValue({ revision: "v2", manifest: { files: [], env: {} } });
  expect((await POST(request(), context)).status).toBe(429);
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.heartbeat).not.toHaveBeenCalled();
  expect(mocks.after).not.toHaveBeenCalled();
});
