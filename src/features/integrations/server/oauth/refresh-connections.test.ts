import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  seal: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("nanoid", () => ({ nanoid: () => "lease-123" }));

vi.mock("../../catalog", () => ({
  getProvider: () => ({
    id: "supabase",
    displayName: "Supabase",
    mcpUrl: "https://mcp.supabase.com/mcp",
    trustedHostnames: ["mcp.supabase.com"],
    trustedAuthorizationServerOrigins: ["https://api.supabase.com"],
  }),
}));

vi.mock("../../env-keys", () => ({
  maskCredential: () => "token…fresh",
}));

vi.mock("../crypto", () => ({
  getSecretSealer: () => ({ open: mocks.open, seal: mocks.seal }),
  secretContext: () => "aad",
}));

vi.mock("./flow", () => ({
  refreshOAuthTokens: mocks.refresh,
  tokenExpiryFrom: () => 2_000_000,
}));

import {
  oauthConnectionNeedsRefresh,
  refreshExpiredOAuthConnections,
  refreshFailureNeedsReauth,
} from "./refresh-connections";

const sealed = {
  kekProvider: "local",
  kekKeyId: "key-1",
  wrappedDek: "wrapped",
  ciphertext: "ciphertext",
  iv: "iv",
  authTag: "tag",
};

function connection(overrides: Record<string, unknown> = {}) {
  return {
    _id: "connection-1",
    providerId: "supabase",
    label: "Supabase",
    authMode: "oauth" as const,
    credentialRef: "credential-ref",
    ...sealed,
    scopes: ["database"],
    tokenExpiresAt: Date.now() - 1_000,
    authServerUrl: "https://api.supabase.com",
    ...overrides,
  };
}

function dependencies(claim: "acquired" | "busy" | "not_needed" = "acquired") {
  return {
    claim: vi.fn().mockResolvedValue(claim),
    complete: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue(true),
  };
}

describe("expired OAuth connection refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.open.mockResolvedValue(
      JSON.stringify({
        type: "oauth",
        accessToken: "old-access-token",
        refreshToken: "stable-refresh-token",
        tokenType: "Bearer",
        clientInformation: { client_id: "client-1" },
        authorizationServerMetadata: {
          token_endpoint: "https://api.supabase.com/v1/oauth/token",
        },
      }),
    );
    mocks.seal.mockResolvedValue(sealed);
    mocks.refresh.mockResolvedValue({
      ok: true,
      tokens: {
        access_token: "new-access-token",
        token_type: "Bearer",
        expires_in: 3600,
      },
    });
  });

  it("refreshes under a lease and persists only a newly sealed bundle", async () => {
    const deps = dependencies();
    const report = await refreshExpiredOAuthConnections([connection()], deps);

    expect(report).toEqual({
      refreshedConnectionIds: ["connection-1"],
      warnings: [],
    });
    expect(deps.claim).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "connection-1", leaseId: "lease-123" }),
    );
    expect(deps.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "connection-1",
        maskedPreview: "token…fresh",
        tokenExpiresAt: 2_000_000,
        sealed,
      }),
    );

    const resealedPlaintext = JSON.parse(mocks.seal.mock.calls[0][0]);
    expect(resealedPlaintext.accessToken).toBe("new-access-token");
    expect(resealedPlaintext.refreshToken).toBe("stable-refresh-token");
    expect(JSON.stringify(deps.complete.mock.calls)).not.toContain(
      "new-access-token",
    );
  });

  it("does not use an expired token while another worker owns the lease", async () => {
    const deps = dependencies("busy");
    const report = await refreshExpiredOAuthConnections([connection()], deps);

    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
    expect(report.warnings[0]).toContain("already being refreshed");
  });

  it("marks a terminal refresh failure for reauthorization without leaking it", async () => {
    mocks.refresh.mockResolvedValue({
      ok: false,
      error: "invalid_grant: refresh token secret-value-123 was revoked",
    });
    const deps = dependencies();

    const report = await refreshExpiredOAuthConnections([connection()], deps);

    expect(deps.fail).toHaveBeenCalledWith({
      connectionId: "connection-1",
      leaseId: "lease-123",
      reauthRequired: true,
    });
    expect(report.warnings[0]).toContain("Reconnect this integration");
    expect(report.warnings.join(" ")).not.toContain("secret-value-123");
  });

  it("leaves fresh connections untouched", async () => {
    const deps = dependencies();
    await refreshExpiredOAuthConnections(
      [connection({ tokenExpiresAt: Date.now() + 3_600_000 })],
      deps,
    );

    expect(deps.claim).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });
});

describe("refreshFailureNeedsReauth", () => {
  it("distinguishes revoked grants from transient transport failures", () => {
    expect(refreshFailureNeedsReauth("invalid_grant")).toBe(true);
    expect(refreshFailureNeedsReauth("HTTP 401 Unauthorized")).toBe(true);
    expect(refreshFailureNeedsReauth("socket timed out")).toBe(false);
  });
});

describe("oauthConnectionNeedsRefresh", () => {
  it("flags expired and near-expiry OAuth tokens only", () => {
    const now = 1_000_000;
    expect(
      oauthConnectionNeedsRefresh(
        { authMode: "oauth", tokenExpiresAt: now + 30_000 },
        now,
      ),
    ).toBe(true);
    expect(
      oauthConnectionNeedsRefresh(
        { authMode: "oauth", tokenExpiresAt: now + 3_600_000 },
        now,
      ),
    ).toBe(false);
    expect(
      oauthConnectionNeedsRefresh(
        { authMode: "api_key", tokenExpiresAt: now - 1 },
        now,
      ),
    ).toBe(false);
  });
});
