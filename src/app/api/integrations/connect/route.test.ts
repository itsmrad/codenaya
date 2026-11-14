import { beforeEach, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
  seal: vi.fn(),
  probe: vi.fn(),
  safeUrl: vi.fn(),
}));
vi.mock("@/features/auth/server/require-user-id", () => ({
  requireUserId: async () => ({ userId: "alice" }),
}));
vi.mock("@/lib/convex-client", () => ({
  convex: { query: mocks.query, mutation: mocks.mutation },
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true }),
  CONNECT_RATE_LIMIT: {},
}));
vi.mock("@/features/integrations/server/mcp/probe", () => ({
  probeMcpServer: mocks.probe,
}));
vi.mock("@/features/integrations/server/url-guard", () => ({
  assertSafeMcpUrl: mocks.safeUrl,
}));
vi.mock("@/features/integrations/server/crypto", async (original) => ({
  ...(await original<object>()),
  getSecretSealer: () => ({ seal: mocks.seal }),
}));

import { POST } from "./route";

const sealed = {
  kekProvider: "local",
  kekKeyId: "k",
  wrappedDek: "d",
  ciphertext: "c",
  iv: "i",
  authTag: "a",
};
const body = {
  providerId: "custom",
  connectionId: "connection",
  apiKey: "replacement",
};
const send = (data = body) =>
  POST(
    new Request("http://localhost/api/integrations/connect", {
      method: "POST",
      body: JSON.stringify(data),
      headers: { "Content-Type": "application/json" },
    }),
  );

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
  mocks.query.mockResolvedValue({
    _id: "connection",
    credentialRef: "stable-ref",
    serverUrl: "https://example.com/mcp",
  });
  mocks.mutation.mockResolvedValue(null);
  mocks.seal.mockResolvedValue(sealed);
  mocks.safeUrl.mockResolvedValue({
    ok: true,
    url: new URL("https://example.com/mcp"),
  });
  mocks.probe.mockResolvedValue({ ok: true, tools: [], truncated: false });
});

it("replaces a key using the original encryption context and endpoint, without creating a connection", async () => {
  const response = await send();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    connectionId: "connection",
    linkedToProject: false,
  });
  expect(mocks.safeUrl).toHaveBeenCalledWith("https://example.com/mcp");
  expect(mocks.seal.mock.calls[0][1]).toContain("stable-ref");
  expect(mocks.mutation).toHaveBeenCalledTimes(1);
  const [[ref, args]] = mocks.mutation.mock.calls;
  expect(getFunctionName(ref)).toBe(
    "system:updateUserConnectionCredential",
  );
  expect(args).toMatchObject({
    userId: "alice",
    connectionId: "connection",
    authMode: "api_key",
    serverUrl: "https://example.com/mcp",
    scopes: [],
    ...sealed,
  });
});

it("rejects a missing or foreign connection before probing or sealing", async () => {
  mocks.query.mockResolvedValue(null);
  expect((await send()).status).toBe(404);
  expect(mocks.probe).not.toHaveBeenCalled();
  expect(mocks.seal).not.toHaveBeenCalled();
  expect(mocks.mutation).not.toHaveBeenCalled();
});

it("leaves the old credential intact when the replacement fails its probe", async () => {
  mocks.probe.mockResolvedValue({
    ok: false,
    kind: "unauthorized",
    error: "Rejected",
  });
  expect((await send()).status).toBe(400);
  expect(mocks.seal).not.toHaveBeenCalled();
  expect(mocks.mutation).not.toHaveBeenCalled();
});
