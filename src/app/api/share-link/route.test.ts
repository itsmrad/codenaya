import { beforeEach, expect, test, vi } from "vitest";
import { resetRateLimits } from "@/lib/rate-limit";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), action: vi.fn(), state: vi.fn(), prepare: vi.fn(), heartbeat: vi.fn(), after: vi.fn(), boot: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("convex/nextjs", () => ({ fetchAction: mocks.action }));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/features/share/server/public-preview", () => ({ previewState: mocks.state, preparePreview: mocks.prepare, heartbeatPreview: mocks.heartbeat, bootPreview: mocks.boot }));
import { POST } from "./route";
const request = (extra = {}) => new Request("http://localhost:3100/api/share-link", { method: "POST", body: JSON.stringify({ projectId: "project", mode: "snapshot", minutes: 0, ...extra }) });
beforeEach(() => {
  vi.resetAllMocks(); resetRateLimits();
  mocks.auth.mockResolvedValue({ userId: "owner", getToken: async () => "jwt" });
  mocks.action.mockResolvedValue("same-slug");
  mocks.state.mockResolvedValue({ status: "boot" });
});
test("rejects anonymous and malformed requests before saving or booting", async () => {
  expect((await POST(request({ minutes: 7 }))).status).toBe(400);
  mocks.auth.mockResolvedValue({ userId: null });
  expect((await POST(request())).status).toBe(401);
  expect(mocks.action).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
});
test("on-demand Generate saves once with owner auth without starting a sandbox", async () => {
  expect(await (await POST(request())).json()).toEqual({ status: "saved" });
  expect(mocks.action).toHaveBeenCalledTimes(1);
  expect(mocks.action).toHaveBeenCalledWith(expect.anything(), { projectId: "project", options: { mode: "snapshot", minutes: 0, updateSnapshot: false } }, { token: "jwt" });
  expect(mocks.prepare).not.toHaveBeenCalled();
});
test("keep-live Generate schedules one boot without deriving policy from the request origin", async () => {
  const prepared = { state: { status: "boot" } };
  mocks.prepare.mockResolvedValue(prepared);
  expect(await (await POST(request({ minutes: 15 }))).json()).toEqual({ status: "boot" });
  expect(mocks.after).toHaveBeenCalledTimes(1);
  await mocks.after.mock.calls[0][0]();
  expect(mocks.boot).toHaveBeenCalledWith("same-slug", prepared);
});
test("Update attaches to the existing unchanged build without booting", async () => {
  const state = { status: "ready", sandboxId: "e2b:one" };
  mocks.state.mockResolvedValue(state);
  mocks.prepare.mockResolvedValue({ state });
  mocks.heartbeat.mockResolvedValue(state);
  expect(await (await POST(request({ minutes: 30 }))).json()).toEqual({ status: "ready" });
  expect(mocks.prepare).toHaveBeenCalledWith("same-slug", undefined, true);
  expect(mocks.after).not.toHaveBeenCalled();
});
test("only an actual owner-cap result returns busy", async () => {
  mocks.prepare.mockResolvedValue({ state: { status: "busy" } });
  expect(await (await POST(request({ minutes: 15 }))).json()).toEqual({ status: "busy" });
});

test("enable-only authenticates without applying drafts or preparing another build", async () => {
  const response = await POST(new Request("http://localhost:3100/api/share-link", { method: "POST",
    body: JSON.stringify({ projectId: "project", enableOnly: true, mode: "latest", minutes: 30, updateSnapshot: true }),
  }));
  expect(await response.json()).toEqual({ status: "saved" });
  expect(mocks.action).toHaveBeenCalledWith(expect.anything(), { projectId: "project" }, { token: "jwt" });
  expect(mocks.state).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
});
