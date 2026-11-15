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

// Public protected-resource + authorization-server discovery verified 2026-11-15.
// Mixpanel's authorization server is same-site (auth.mixpanel.com for mcp.mixpanel.com).
const CASES = [
  ["amplitude", "https://mcp.amplitude.com", "https://mcp.amplitude.com/register"],
  ["amplitude-eu", "https://mcp.eu.amplitude.com", "https://mcp.eu.amplitude.com/register"],
  ["mixpanel", "https://auth.mixpanel.com", "https://mixpanel.com/oauth/mcp/register/"],
  ["contentful", "https://mcp.contentful.com", "https://mcp.contentful.com/register"],
  ["contentful-eu", "https://mcp.eu.contentful.com", "https://mcp.eu.contentful.com/register"],
] as const;
const redirectUri = "https://app.example.test/api/integrations/oauth/callback";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.register.mockResolvedValue({ client_id: "mock-client", redirect_uris: [redirectUri] });
  mocks.authorize.mockResolvedValue({
    authorizationUrl: new URL("https://example.test/authorize"), codeVerifier: "mock-verifier",
  });
});

describe.each(CASES)("%s OAuth discovery and DCR", (id, issuer, registrationEndpoint) => {
  const metadata = { issuer, registration_endpoint: registrationEndpoint };

  beforeEach(() => {
    mocks.discover.mockResolvedValue({
      authorizationServerUrl: issuer, authorizationServerMetadata: metadata,
    });
  });

  it("accepts the verified same-site issuer and binds registration and authorization to this MCP resource", async () => {
    const provider = PROVIDERS[id];
    const result = await startOAuthFlow({ provider, redirectUri });
    expect(result).toMatchObject({ ok: true, start: { authorizationServerUrl: issuer, issuer } });
    expect(mocks.discover).toHaveBeenCalledWith(provider.mcpUrl, { fetchFn: mocks.fetch });
    expect(mocks.register).toHaveBeenCalledWith(issuer, expect.objectContaining({
      metadata, fetchFn: mocks.fetch,
      clientMetadata: expect.objectContaining({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
    }));
    expect(mocks.authorize).toHaveBeenCalledWith(issuer, expect.objectContaining({
      metadata, resource: new URL(provider.mcpUrl), redirectUrl: redirectUri,
    }));
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("returns discovery failure before registration", async () => {
    mocks.discover.mockRejectedValue(new Error("discovery unavailable"));
    expect(await startOAuthFlow({ provider: PROVIDERS[id], redirectUri })).toMatchObject({
      ok: false, error: expect.stringContaining("Could not discover OAuth configuration"),
    });
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it("returns DCR failure without starting authorization", async () => {
    mocks.register.mockRejectedValue(new Error("registration unavailable"));
    expect(await startOAuthFlow({ provider: PROVIDERS[id], redirectUri })).toMatchObject({
      ok: false, error: expect.stringContaining("did not accept dynamic client registration"),
    });
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it("rejects an unrelated discovered authorization server before DCR", async () => {
    mocks.discover.mockResolvedValue({ authorizationServerUrl: "https://unrelated.example.test" });
    expect(await startOAuthFlow({ provider: PROVIDERS[id], redirectUri })).toMatchObject({
      ok: false, error: expect.stringContaining("Refusing to send the user there"),
    });
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
});

it("requests Mixpanel's documented scopes at registration and authorization", async () => {
  const issuer = "https://auth.mixpanel.com";
  mocks.discover.mockResolvedValue({
    authorizationServerUrl: issuer,
    authorizationServerMetadata: { issuer, registration_endpoint: "https://mixpanel.com/oauth/mcp/register/" },
  });
  const scope = PROVIDERS.mixpanel.oauthScopes?.join(" ");
  expect(scope).toContain("data:read");
  expect(await startOAuthFlow({ provider: PROVIDERS.mixpanel, redirectUri })).toMatchObject({ ok: true });
  expect(mocks.register).toHaveBeenCalledWith(issuer, expect.objectContaining({ scope }));
  expect(mocks.authorize).toHaveBeenCalledWith(issuer, expect.objectContaining({ scope }));
});
