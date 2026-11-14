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
const CASES = [
  ["notion", "https://mcp.notion.com", "https://mcp.notion.com/register"],
  ["atlassian", "https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3", "https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3/dcr/register"],
  ["gitlab", "https://gitlab.com", "https://gitlab.com/oauth/register"],
  ["clerk", "https://clerk.clerk.com", "https://clerk.clerk.com/oauth/register"],
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
