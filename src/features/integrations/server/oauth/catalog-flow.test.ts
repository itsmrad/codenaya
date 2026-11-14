import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  discover: vi.fn(), register: vi.fn(), authorize: vi.fn(), fetch: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  discoverOAuthServerInfo: mocks.discover,
  registerClient: mocks.register,
  startAuthorization: mocks.authorize,
  exchangeAuthorization: vi.fn(),
  refreshAuthorization: vi.fn(),
}));
vi.mock("../mcp/guarded-fetch", () => ({ createGuardedFetch: () => mocks.fetch }));

import { PROVIDERS } from "../../catalog";
import { startOAuthFlow } from "./flow";

// Public /.well-known/oauth-authorization-server metadata verified 2026-11-15.
const CASES = [
  ["posthog", "https://oauth.posthog.com", "https://oauth.posthog.com/oauth/register/"],
  ["resend", "https://api.resend.com", "https://api.resend.com/oauth/register"],
  ["upstash", "https://clerk.upstash.com", "https://clerk.upstash.com/oauth/register"],
  ["sanity", "https://mcp.sanity.io", "https://mcp.sanity.io/register"],
  ["planetscale", "https://api.planetscale.com", "https://auth.planetscale.com/oauth/registration"],
] as const;
const redirectUri = "https://app.example.test/api/integrations/oauth/callback";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.register.mockResolvedValue({ client_id: "mock-client", redirect_uris: [redirectUri] });
  mocks.authorize.mockResolvedValue({
    authorizationUrl: new URL("https://example.test/authorize"), codeVerifier: "mock-verifier",
  });
});

describe.each(CASES)("%s OAuth discovery and DCR", (id, origin, registrationEndpoint) => {
  it("passes verified discovery metadata to registration and binds authorization to the MCP resource", async () => {
    const provider = PROVIDERS[id];
    const metadata = { issuer: origin, registration_endpoint: registrationEndpoint };
    mocks.discover.mockResolvedValue({
      authorizationServerUrl: origin, authorizationServerMetadata: metadata,
    });
    const result = await startOAuthFlow({ provider, redirectUri });
    expect(result).toMatchObject({ ok: true, start: { authorizationServerUrl: origin, issuer: origin } });
    expect(mocks.discover).toHaveBeenCalledWith(provider.mcpUrl, { fetchFn: mocks.fetch });
    expect(mocks.register).toHaveBeenCalledWith(origin, expect.objectContaining({
      metadata, fetchFn: mocks.fetch,
      clientMetadata: expect.objectContaining({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
    }));
    expect(mocks.authorize).toHaveBeenCalledWith(origin, expect.objectContaining({
      metadata, resource: new URL(provider.mcpUrl), redirectUrl: redirectUri,
    }));
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("returns registration failure without starting authorization", async () => {
    mocks.discover.mockResolvedValue({
      authorizationServerUrl: origin,
      authorizationServerMetadata: { issuer: origin, registration_endpoint: registrationEndpoint },
    });
    mocks.register.mockRejectedValue(new Error("registration unavailable"));
    const result = await startOAuthFlow({ provider: PROVIDERS[id], redirectUri });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("did not accept dynamic client registration") });
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
});

it("rejects a wrong PlanetScale discovery origin before registration", async () => {
  mocks.discover.mockResolvedValue({ authorizationServerUrl: "https://auth.planetscale.com" });
  expect(await startOAuthFlow({ provider: PROVIDERS.planetscale, redirectUri })).toMatchObject({
    ok: false, error: expect.stringContaining("not in the trusted list"),
  });
  expect(mocks.register).not.toHaveBeenCalled();
  expect(mocks.authorize).not.toHaveBeenCalled();
});
