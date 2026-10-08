import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderDefinition } from "../../types";

const mocks = vi.hoisted(() => ({
  discoverOAuthServerInfo: vi.fn(),
  exchangeAuthorization: vi.fn(),
  refreshAuthorization: vi.fn(),
  registerClient: vi.fn(),
  startAuthorization: vi.fn(),
  fetchFn: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  discoverOAuthServerInfo: mocks.discoverOAuthServerInfo,
  exchangeAuthorization: mocks.exchangeAuthorization,
  refreshAuthorization: mocks.refreshAuthorization,
  registerClient: mocks.registerClient,
  startAuthorization: mocks.startAuthorization,
}));

vi.mock("../mcp/guarded-fetch", () => ({
  createGuardedFetch: () => mocks.fetchFn,
}));

vi.mock("./as-guard", () => ({
  validateAuthorizationServer: () => ({
    ok: true,
    origin: "https://auth.example.com",
  }),
}));

import {
  completeOAuthFlow,
  refreshOAuthTokens,
  startOAuthFlow,
} from "./flow";

const provider: ProviderDefinition = {
  id: "example",
  displayName: "Example",
  mcpUrl: "https://mcp.example.com/mcp",
  authModes: ["oauth"],
  trustedHostnames: ["mcp.example.com"],
  supportsReadOnly: false,
  scope: { queryParams: [], headers: [] },
  destructiveTools: [],
};

const metadata = {
  issuer: "https://auth.example.com",
  authorization_endpoint: "https://auth.example.com/oauth/authorize",
  token_endpoint: "https://auth.example.com/oauth/token",
  registration_endpoint: "https://auth.example.com/oauth/register",
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
};

const clientInformation = {
  client_id: "client-123",
  redirect_uris: ["https://app.example.com/api/integrations/oauth/callback"],
};

describe("OAuth metadata handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.discoverOAuthServerInfo.mockResolvedValue({
      authorizationServerUrl: "https://auth.example.com",
      authorizationServerMetadata: metadata,
    });
    mocks.registerClient.mockResolvedValue(clientInformation);
    mocks.startAuthorization.mockResolvedValue({
      authorizationUrl: new URL(
        "https://auth.example.com/oauth/authorize?state=state-123",
      ),
      codeVerifier: "verifier-123",
    });
    mocks.exchangeAuthorization.mockResolvedValue({
      access_token: "access-123",
      token_type: "Bearer",
    });
    mocks.refreshAuthorization.mockResolvedValue({
      access_token: "access-456",
      token_type: "Bearer",
    });
  });

  it("carries discovered metadata from authorization start into token exchange", async () => {
    const started = await startOAuthFlow({
      provider,
      redirectUri: "https://app.example.com/api/integrations/oauth/callback",
    });

    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect(started.start.authorizationServerMetadata).toEqual(metadata);

    const completed = await completeOAuthFlow({
      provider,
      authorizationServerUrl: started.start.authorizationServerUrl,
      authorizationServerMetadata:
        started.start.authorizationServerMetadata,
      authorizationCode: "code-123",
      codeVerifier: started.start.codeVerifier,
      redirectUri: "https://app.example.com/api/integrations/oauth/callback",
      clientInformation: started.start.clientInformation,
    });

    expect(completed.ok).toBe(true);
    expect(mocks.exchangeAuthorization).toHaveBeenCalledWith(
      "https://auth.example.com",
      expect.objectContaining({ metadata }),
    );
  });

  it("uses the advertised token endpoint metadata when refreshing", async () => {
    const refreshed = await refreshOAuthTokens({
      provider,
      authorizationServerUrl: "https://auth.example.com",
      authorizationServerMetadata: metadata,
      refreshToken: "refresh-123",
      clientInformation,
    });

    expect(refreshed.ok).toBe(true);
    expect(mocks.refreshAuthorization).toHaveBeenCalledWith(
      "https://auth.example.com",
      expect.objectContaining({ metadata }),
    );
  });
});
