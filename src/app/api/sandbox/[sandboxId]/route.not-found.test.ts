import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), connect: vi.fn() }));

vi.mock("@/features/auth/server/require-user-id", () => ({ requireUserId: mocks.auth }));
vi.mock("e2b", async (importOriginal) => ({
  ...(await importOriginal<typeof import("e2b")>()),
  Sandbox: { connect: mocks.connect },
}));

import { AuthenticationError, SandboxNotFoundError } from "e2b";

import { resetRateLimits } from "@/lib/rate-limit";

import { DELETE, PATCH, POST } from "./route";

/** The real registry and E2B adapter, with E2B answering from `connect`. */
const url = "http://localhost/api/sandbox/sbx_gone";
const at = { params: Promise.resolve({ sandboxId: "sbx_gone" }) };
const calls = () => [
  DELETE(new Request(url, { method: "DELETE" }), at),
  POST(new Request(url, { method: "POST", body: '{"action":"recover-esbuild"}' }), at),
  PATCH(new Request(url, { method: "PATCH", body: JSON.stringify({ files: [{ path: "src/App.tsx", content: "x" }] }) }), at),
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("E2B_API_KEY", "e2b_key");
  vi.stubEnv("SANDBOX_PROVIDER_FALLBACKS", "");
  resetRateLimits();
  mocks.auth.mockResolvedValue({ userId: "alice", unauthorized: null });
});

describe("a sandbox E2B no longer has (PR3c)", () => {
  it("answers DELETE, recovery POST and PATCH with the unknown-id 404", async () => {
    mocks.connect.mockRejectedValue(new SandboxNotFoundError("Paused sandbox sbx_gone not found"));

    for (const response of await Promise.all(calls())) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Sandbox not found" });
    }
    expect(mocks.connect).toHaveBeenCalledTimes(3);
  });

  it("still surfaces any other provider failure as before", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.connect.mockRejectedValue(new AuthenticationError("bad key"));

    const [deleted, recovered, patched] = await Promise.all(calls());

    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ success: false, error: "bad key" });
    expect(recovered.status).toBe(502);
    expect(patched.status).toBe(500);
  });
});
