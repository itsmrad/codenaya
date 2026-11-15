/**
 * The callback page reflects the provider's `error_description`, which anyone
 * can set with a crafted link. It must stay inert text in both the page and the
 * inline script (#222).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), query: vi.fn(), mutation: vi.fn(), open: vi.fn(), seal: vi.fn(), exchange: vi.fn() }));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("@/lib/convex-client", () => ({ convex: { query: mocks.query, mutation: mocks.mutation } }));
vi.mock("@/features/integrations/server/crypto", async (original) => ({
  ...await original<object>(), getSecretSealer: () => ({ open: mocks.open, seal: mocks.seal }),
}));
vi.mock("@/features/integrations/server/oauth/flow", async (original) => ({
  ...await original<object>(), completeOAuthFlow: mocks.exchange,
}));

import { getFunctionName } from "convex/server";

import { GET } from "./route";

const BREAKOUTS = [
  "</script><script>alert(1)</script>",
  '"});alert(1);//',
  "line sep para",
];

async function renderError(description: string) {
  const url = new URL("http://localhost:3000/api/integrations/oauth/callback");
  url.searchParams.set("error", "access_denied");
  url.searchParams.set("error_description", description);
  const response = await GET(new Request(url));
  return { response, html: await response.text() };
}

/** Runs the page's inline script against a fake opener, returning what it posted. */
function runScript(html: string) {
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
  const postMessage = vi.fn();
  new Function("window", "setTimeout", script)(
    { opener: { postMessage }, location: { origin: "http://localhost:3000" } },
    () => {},
  );
  return postMessage;
}

describe("GET /api/integrations/oauth/callback", () => {
  beforeEach(() => {
    mocks.auth.mockResolvedValue({ userId: "user_1" });
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
  });

  it.each(BREAKOUTS)("keeps error_description %j inert", async (payload) => {
    const { response, html } = await renderError(payload);

    expect(response.status).toBe(400);
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).not.toContain("alert(1)</script>");
    expect(html.split("<script>")[1]).not.toMatch(/[\u2028\u2029]/);

    const postMessage = runScript(html);
    expect(postMessage).toHaveBeenCalledWith(
      {
        source: "codenaya-oauth",
        status: "error",
        message: `The provider declined the request: ${payload}`,
      },
      "http://localhost:3000",
    );
  });

  it("HTML-escapes the message in the page text", async () => {
    const { html } = await renderError("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
  });
});


describe("OAuth reconnect callback", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
    mocks.auth.mockResolvedValue({ userId: "alice" });
    mocks.query.mockResolvedValueOnce({
      _id: "flow", state: "state", userId: "alice", providerId: "supabase", expiresAt: Date.now() + 60_000,
      serverUrl: "https://mcp.supabase.com/mcp", authServerUrl: "https://api.supabase.com", redirectUri: "http://localhost/api/integrations/oauth/callback",
    }).mockResolvedValue({ _id: "connection", credentialRef: "stable-ref" });
    mocks.open.mockResolvedValue(JSON.stringify({ connectionId: "connection", codeVerifier: "verifier", clientInformation: { client_id: "client" } }));
    mocks.exchange.mockResolvedValue({ ok: true, tokens: { access_token: "replacement", token_type: "Bearer" } });
    mocks.seal.mockResolvedValue({ kekProvider: "local", kekKeyId: "k", wrappedDek: "d", ciphertext: "c", iv: "i", authTag: "a" });
  });

  it("replaces the original credential after checking the encrypted reconnect target", async () => {
    const response = await GET(new Request("http://localhost/api/integrations/oauth/callback?code=code&state=state"));
    expect(response.status).toBe(200);
    expect(mocks.seal.mock.calls[0][1]).toContain("stable-ref");
    const calls = mocks.mutation.mock.calls.map(([ref, args]) => [getFunctionName(ref), args]);
    expect(calls.map(([name]) => name)).toEqual(["system:deleteOauthFlowState", "system:updateUserConnectionCredential"]);
    expect(calls[1][1]).toMatchObject({
      connectionId: "connection", userId: "alice", authMode: "oauth", serverUrl: "https://mcp.supabase.com/mcp", scopes: [],
    });
  });

  it("does not exchange tokens when the reconnect target was deleted or changed owner", async () => {
    mocks.query.mockReset().mockResolvedValueOnce({
      _id: "flow", state: "state", userId: "alice", providerId: "supabase", expiresAt: Date.now() + 60_000,
    }).mockResolvedValueOnce(null);
    expect((await GET(new Request("http://localhost/api/integrations/oauth/callback?code=code&state=state"))).status).toBe(400);
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(mocks.seal).not.toHaveBeenCalled();
  });
});
