/**
 * An env change through these routes ends with the project's previews that
 * still hold the old value killed (runtime admission fence, stage 4b).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), query: vi.fn(), mutation: vi.fn(), kill: vi.fn() }));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("@/lib/convex-client", () => ({ convex: { query: mocks.query, mutation: mocks.mutation } }));
vi.mock("@/features/sandbox-preview/server/provider/registry", () => ({ getProvider: () => ({ kill: mocks.kill }) }));
vi.mock("@/features/integrations/server/crypto", () => ({
  getSecretSealer: () => ({
    seal: async () => ({ kekProvider: "local", kekKeyId: "k1", wrappedDek: "dek", ciphertext: "ct", iv: "iv", authTag: "tag" }),
  }),
  secretContext: () => "ctx",
}));

import { resetRateLimits } from "@/lib/rate-limit";
import { DELETE, POST } from "./route";

const call = (handler: typeof POST, body: unknown) =>
  handler(new Request("http://localhost/api/env-vars", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.resetAllMocks();
  resetRateLimits();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "internal");
  mocks.auth.mockResolvedValue({ userId: "user_1" });
  // Owned project; the running preview's handle is revoked by the change.
  mocks.query.mockImplementation(async (_ref, args: Record<string, unknown>) =>
    "userId" in args ? { _id: "proj_1", ownerId: "user_1" } : [{ _id: "handle_1", sandboxId: "e2b:sbx_running" }],
  );
  mocks.kill.mockResolvedValue(true);
});

describe.each([
  ["DELETE", DELETE, { projectId: "proj_1", key: "API_KEY" }],
  ["POST", POST, { projectId: "proj_1", key: "API_KEY", value: "synthetic-value" }],
] as const)("%s /api/env-vars", (_method, handler, body) => {
  it("kills the project's running preview after the change", async () => {
    const res = await call(handler, body);

    expect(res.status).toBe(200);
    expect(mocks.mutation.mock.calls[0][1]).toMatchObject({ internalKey: "internal", projectId: "proj_1", ownerId: "user_1", key: "API_KEY" });
    expect(mocks.query).toHaveBeenLastCalledWith(expect.anything(), { internalKey: "internal", projectId: "proj_1", sandboxId: undefined });
    expect(mocks.kill).toHaveBeenCalledWith("sbx_running");
    expect(mocks.mutation).toHaveBeenLastCalledWith(expect.anything(), { internalKey: "internal", handleId: "handle_1", killed: true });
  });

  it("keeps the change and leaves a failed kill to the sweep", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.kill.mockRejectedValue(new Error("E2B unavailable"));

    const res = await call(handler, body);

    expect(res.status).toBe(200);
    expect(mocks.mutation).toHaveBeenLastCalledWith(expect.anything(), { internalKey: "internal", handleId: "handle_1", killed: false });
  });

  it("changes nothing and kills nothing in a project the caller does not own", async () => {
    mocks.query.mockResolvedValue(null);

    const res = await call(handler, body);

    expect(res.status).toBe(404);
    expect(mocks.mutation).not.toHaveBeenCalled();
    expect(mocks.kill).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/env-vars", () => {
  it("answers 400 for a body without a key", async () => {
    const res = await call(DELETE, { projectId: "proj_1" });

    expect(res.status).toBe(400);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});
