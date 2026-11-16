import { beforeEach, expect, test, vi } from "vitest";
import { resetRateLimits } from "@/lib/rate-limit";

const mocks = vi.hoisted(() => ({ after: vi.fn(), boot: vi.fn(), heartbeat: vi.fn(), prepare: vi.fn(), state: vi.fn() }));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/features/share/server/public-preview", () => ({ bootPreview: mocks.boot, heartbeatPreview: mocks.heartbeat, preparePreview: mocks.prepare, previewState: mocks.state }));
import { GET, POST } from "./route";
const token = "a".repeat(32);
const context = { params: Promise.resolve({ token }) };
const request = () => new Request(`https://example.com/api/public-preview/${token}`, { method: "POST", headers: { "x-forwarded-for": "203.0.113.5" } });

beforeEach(() => { vi.resetAllMocks(); resetRateLimits(); });

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
  expect(mocks.after).not.toHaveBeenCalled();
});

test("starting is rate limited per IP before loading the manifest", async () => {
  mocks.prepare.mockResolvedValue({ state: { status: "wait" } });
  for (let n = 0; n < 5; n++) expect((await POST(request(), context)).status).toBe(200);
  const response = await POST(request(), context);
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBeTruthy();
  expect(mocks.prepare).toHaveBeenCalledTimes(5);
});

test("a reserved cold start schedules exactly one boot callback", async () => {
  mocks.prepare.mockResolvedValue({ state: { status: "boot", lease: "one" }, manifest: { files: [], env: {} } });
  expect(await (await POST(request(), context)).json()).toEqual({ status: "boot" });
  expect(mocks.after).toHaveBeenCalledTimes(1);
  expect(mocks.boot).not.toHaveBeenCalled();
  await mocks.after.mock.calls[0][0]();
  expect(mocks.boot).toHaveBeenCalledTimes(1);
});
