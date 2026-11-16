import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), getOwnedSandbox: vi.fn(), recoverEsbuild: vi.fn() }));
vi.mock("@/features/auth/server/require-user-id", () => ({ requireUserId: mocks.auth }));
vi.mock("@/features/sandbox-preview/server/sandbox-registry", () => ({ getOwnedSandbox: mocks.getOwnedSandbox }));
vi.mock("@/features/sandbox-preview/server/recover-esbuild", () => ({ recoverEsbuild: mocks.recoverEsbuild }));
import { DELETE, PATCH, POST } from "./route";
import { resetRateLimits } from "@/lib/rate-limit";

const params = { params: Promise.resolve({ sandboxId: "sbx_1" }) };
const post = (body = '{"action":"recover-esbuild"}') => POST(new Request("http://localhost/api/sandbox/sbx_1", { method: "POST", body }), params);
beforeEach(() => {
  vi.resetAllMocks();
  resetRateLimits();
  mocks.auth.mockResolvedValue({ userId: "alice", unauthorized: null });
  mocks.getOwnedSandbox.mockResolvedValue({ sandboxId: "sbx_1" });
  mocks.recoverEsbuild.mockResolvedValue("restarted");
});

describe("POST sandbox esbuild recovery (#776)", () => {
  it("authenticates before parsing or accessing the sandbox", async () => {
    mocks.auth.mockResolvedValue({ unauthorized: Response.json({ error: "Unauthorized" }, { status: 401 }) });
    expect((await post("{")).status).toBe(401);
    expect(mocks.getOwnedSandbox).not.toHaveBeenCalled();
  });
  it.each(["{", "{}", '{"action":"run-command"}'])("rejects invalid input %s", async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(mocks.getOwnedSandbox).not.toHaveBeenCalled();
  });
  it("does not restart a foreign sandbox", async () => {
    mocks.getOwnedSandbox.mockResolvedValue(null);
    expect((await post()).status).toBe(404);
    expect(mocks.getOwnedSandbox).toHaveBeenCalledWith("sbx_1", "alice");
    expect(mocks.recoverEsbuild).not.toHaveBeenCalled();
  });
  it.each(["restarted", "busy", "limited", "unavailable"])("returns the bounded recovery outcome %s", async (status) => {
    mocks.recoverEsbuild.mockResolvedValue(status);
    expect(await (await post()).json()).toEqual({ status });
  });
  it("bounds requests before another E2B call", async () => {
    for (let i = 0; i < 30; i++) await post();
    expect((await post()).status).toBe(429);
    expect(mocks.getOwnedSandbox).toHaveBeenCalledTimes(30);
  });
  it("does not expose E2B exception text", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mocks.recoverEsbuild.mockRejectedValue(new Error("private-command-env"));
      const response = await post();
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain("private-command-env");
      expect(warning).toHaveBeenCalledWith("[sandbox-recovery] Dev server recovery failed");
    } finally { warning.mockRestore(); }
  });
});

describe("malformed sandbox ids (PR3c)", () => {
  const at = (sandboxId: string) => ({ params: Promise.resolve({ sandboxId }) });
  const url = "http://localhost/api/sandbox/x";
  const files = JSON.stringify({ files: [{ path: "src/App.tsx", content: "x" }] });

  it.each(["../sbx", "blaxel:sbx_1", "e2b:", "sbx 1"])("answers %j with the unknown-id 404 before any lookup", async (id) => {
    const responses = [
      await DELETE(new Request(url, { method: "DELETE" }), at(id)),
      await POST(new Request(url, { method: "POST", body: '{"action":"recover-esbuild"}' }), at(id)),
      await PATCH(new Request(url, { method: "PATCH", body: files }), at(id)),
    ];

    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Sandbox not found" });
    }
    expect(mocks.getOwnedSandbox).not.toHaveBeenCalled();
    expect(mocks.recoverEsbuild).not.toHaveBeenCalled();
  });

  it("answers a well-formed id nobody owns with the same 404", async () => {
    mocks.getOwnedSandbox.mockResolvedValue(null);
    const response = await DELETE(new Request(url, { method: "DELETE" }), at("sbx_9"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Sandbox not found" });
  });
});
