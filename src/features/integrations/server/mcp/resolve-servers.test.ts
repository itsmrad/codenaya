import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearDekCache,
  getSecretSealer,
  resetSecretSealer,
  secretContext,
} from "../crypto";
import {
  collectKnownSecrets,
  resolveMcpServers,
  type ConnectionRecord,
  type ProjectLinkRecord,
} from "./resolve-servers";

const KEK = randomBytes(32).toString("base64");

beforeEach(() => {
  vi.stubEnv("CODENAYA_KEK_PROVIDER", "local");
  vi.stubEnv("CODENAYA_LOCAL_KEK", KEK);
  resetSecretSealer();
  clearDekCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetSecretSealer();
});

/** Build a connection row with a real sealed credential. */
async function makeConnection(
  overrides: Partial<ConnectionRecord> & {
    credential?: Record<string, unknown>;
  } = {},
): Promise<ConnectionRecord> {
  const credentialRef = overrides.credentialRef ?? "ref_1";
  const credential = overrides.credential ?? {
    type: "api_key",
    apiKey: "sbp_secretvalue1234567890",
  };

  const sealed = await getSecretSealer().seal(
    JSON.stringify(credential),
    secretContext("userConnections", credentialRef, "credential"),
  );

  return {
    _id: "conn_1",
    providerId: "supabase",
    label: "Supabase",
    authMode: "api_key",
    serverUrl: "https://mcp.supabase.com/mcp",
    credentialRef,
    ...sealed,
    ...overrides,
  } as ConnectionRecord;
}

function makeLink(overrides: Partial<ProjectLinkRecord> = {}): ProjectLinkRecord {
  return {
    _id: "link_1",
    readOnly: true,
    providerScope: {},
    writeApproved: false,
    ...overrides,
  };
}

describe("resolveMcpServers", () => {
  it("resolves a connection into a scoped target", async () => {
    const connection = await makeConnection();
    const link = makeLink({
      readOnly: true,
      providerScope: { projectRef: "abcdefgh", features: ["database", "docs"] },
    });

    const { servers, problems } = await resolveMcpServers([
      { link, connection },
    ]);

    expect(problems).toEqual([]);
    expect(servers).toHaveLength(1);

    const server = servers[0];
    expect(server.providerId).toBe("supabase");
    // Scope must be reflected in the URL, not just stored.
    expect(server.url).toContain("read_only=true");
    expect(server.url).toContain("project_ref=abcdefgh");
    expect(server.url).toContain("features=database%2Cdocs");
  });

  it("attaches the credential as an Authorization header", async () => {
    const connection = await makeConnection({
      credential: { type: "api_key", apiKey: "sbp_mysecretkey1234567890" },
    });

    const { servers } = await resolveMcpServers([
      { link: makeLink(), connection },
    ]);

    expect(servers[0].headers.Authorization).toBe(
      "Bearer sbp_mysecretkey1234567890",
    );
  });

  it("exposes the raw secret for the redaction pass", async () => {
    // This is what lets redactSecrets strip a credential a tool echoes back.
    const connection = await makeConnection({
      credential: { type: "api_key", apiKey: "sbp_redactme1234567890" },
    });

    const { servers } = await resolveMcpServers([
      { link: makeLink(), connection },
    ]);

    expect(servers[0].knownSecrets).toContain("sbp_redactme1234567890");
  });

  it("uses the OAuth access token, not the refresh token", async () => {
    const connection = await makeConnection({
      authMode: "oauth",
      credential: {
        type: "oauth",
        accessToken: "access_tok_1234567890",
        refreshToken: "refresh_tok_must_not_be_used",
      },
    });

    const { servers } = await resolveMcpServers([
      { link: makeLink(), connection },
    ]);

    expect(servers[0].headers.Authorization).toBe("Bearer access_tok_1234567890");
    expect(servers[0].knownSecrets).not.toContain(
      "refresh_tok_must_not_be_used",
    );
  });

  it("namespaces tools per provider", async () => {
    const connection = await makeConnection();
    const { servers } = await resolveMcpServers([
      { link: makeLink(), connection },
    ]);

    expect(servers[0].namespace).toBe("supabase");
  });

  it("sanitises a namespace to identifier-safe characters", async () => {
    // Model providers constrain tool-name characters, so a provider id with a
    // hyphen must not leak into the namespace.
    const connection = await makeConnection({ providerId: "my-custom.server" });
    const { servers } = await resolveMcpServers([
      { link: makeLink(), connection },
    ]);

    expect(servers[0].namespace).toBe("my_custom_server");
  });

  describe("failure isolation", () => {
    it("skips a connection whose credential cannot be decrypted", async () => {
      const good = await makeConnection({ _id: "good", credentialRef: "ref_ok" });
      const bad = await makeConnection({ _id: "bad", credentialRef: "ref_bad" });

      // Simulates a row sealed under a different key, or a tampered ciphertext.
      const corrupted = { ...bad, ciphertext: bad.ciphertext.slice(0, -4) + "AAAA" };

      const { servers, problems } = await resolveMcpServers([
        { link: makeLink({ _id: "link_bad" }), connection: corrupted },
        { link: makeLink({ _id: "link_good" }), connection: good },
      ]);

      // One bad connection must not take down the whole run.
      expect(servers).toHaveLength(1);
      expect(servers[0].userConnectionId).toBe("good");
      expect(problems).toHaveLength(1);
      expect(problems[0].projectConnectionId).toBe("link_bad");
      expect(problems[0].reason).toMatch(/decrypt/i);
    });

    it("skips a credential with no usable token", async () => {
      const connection = await makeConnection({
        credential: { type: "api_key" },
      });

      const { servers, problems } = await resolveMcpServers([
        { link: makeLink(), connection },
      ]);

      expect(servers).toEqual([]);
      expect(problems[0].reason).toMatch(/missing an access token/);
    });

    it("skips a connection with an internally invalid scope", async () => {
      // Sentry rejects a project slug without an org slug rather than silently
      // widening to org scope.
      const connection = await makeConnection({
        providerId: "sentry",
        serverUrl: "https://mcp.sentry.dev/mcp",
      });

      const { servers, problems } = await resolveMcpServers([
        {
          link: makeLink({ providerScope: { projectSlug: "my-project" } }),
          connection,
        },
      ]);

      expect(servers).toEqual([]);
      expect(problems).toHaveLength(1);
      expect(problems[0].reason).toMatch(/orgSlug/);
    });

    it("reports the provider id on every problem so the UI can name it", async () => {
      const connection = await makeConnection({ providerId: "neon" });
      const corrupted = {
        ...connection,
        authTag: Buffer.from(randomBytes(16)).toString("base64"),
      };

      const { problems } = await resolveMcpServers([
        { link: makeLink(), connection: corrupted },
      ]);

      expect(problems[0].providerId).toBe("neon");
    });
  });

  describe("custom servers", () => {
    it("uses the recorded server URL and grants no trusted hosts", async () => {
      // A custom URL is untrusted input, so it must not inherit the catalog's
      // DNS-validation bypass.
      const connection = await makeConnection({
        providerId: "custom",
        serverUrl: "https://mcp.internal-tool.example.com/mcp",
      });

      const { servers } = await resolveMcpServers([
        { link: makeLink(), connection },
      ]);

      expect(servers[0].url).toBe("https://mcp.internal-tool.example.com/mcp");
      expect(servers[0].trustedHostnames).toEqual([]);
      expect(servers[0].destructiveTools).toEqual([]);
    });
  });

  describe("token refresh signalling", () => {
    it("flags an expired OAuth token", async () => {
      const connection = await makeConnection({
        authMode: "oauth",
        credential: { type: "oauth", accessToken: "access_tok_expired_123" },
        tokenExpiresAt: Date.now() - 1000,
      });

      const { servers } = await resolveMcpServers([
        { link: makeLink(), connection },
      ]);

      expect(servers[0].needsRefresh).toBe(true);
    });

    it("flags a token expiring within the skew window", async () => {
      // Refreshing slightly early stops a token expiring mid-turn.
      const connection = await makeConnection({
        authMode: "oauth",
        credential: { type: "oauth", accessToken: "access_tok_soon_1234" },
        tokenExpiresAt: Date.now() + 30_000,
      });

      const { servers } = await resolveMcpServers([
        { link: makeLink(), connection },
      ]);

      expect(servers[0].needsRefresh).toBe(true);
    });

    it("does not flag a token with plenty of life left", async () => {
      const connection = await makeConnection({
        authMode: "oauth",
        credential: { type: "oauth", accessToken: "access_tok_fresh_123" },
        tokenExpiresAt: Date.now() + 3_600_000,
      });

      const { servers } = await resolveMcpServers([
        { link: makeLink(), connection },
      ]);

      expect(servers[0].needsRefresh).toBe(false);
    });

    it("never flags an API key, which does not expire", async () => {
      const connection = await makeConnection({ tokenExpiresAt: 1 });
      const { servers } = await resolveMcpServers([
        { link: makeLink(), connection },
      ]);

      expect(servers[0].needsRefresh).toBe(false);
    });
  });

  it("carries scope, approval state and baseline through", async () => {
    const connection = await makeConnection();
    const link = makeLink({
      readOnly: false,
      writeApproved: true,
      allowedTools: ["list_tables"],
      toolBaseline: [{ name: "list_tables", digest: "abc123" }],
    });

    const { servers } = await resolveMcpServers([{ link, connection }]);

    expect(servers[0].readOnly).toBe(false);
    expect(servers[0].writeApproved).toBe(true);
    expect(servers[0].allowedTools).toEqual(["list_tables"]);
    expect(servers[0].toolBaseline).toEqual([
      { name: "list_tables", digest: "abc123" },
    ]);
    expect(servers[0].destructiveTools).toContain("execute_sql");
  });

  it("returns nothing for no entries", async () => {
    expect(await resolveMcpServers([])).toEqual({ servers: [], problems: [] });
  });
});

describe("collectKnownSecrets", () => {
  it("gathers secrets across every server and de-duplicates", async () => {
    // A tool on one server can return a credential belonging to another — asking
    // Supabase to read a table where the app stored its Stripe key, say — so
    // redaction uses the union rather than per-server values.
    const a = await makeConnection({
      _id: "a",
      credentialRef: "ref_a",
      credential: { type: "api_key", apiKey: "secret_aaaa11112222" },
    });
    const b = await makeConnection({
      _id: "b",
      providerId: "neon",
      credentialRef: "ref_b",
      credential: { type: "api_key", apiKey: "secret_bbbb33334444" },
    });

    const { servers } = await resolveMcpServers([
      { link: makeLink({ _id: "l_a" }), connection: a },
      { link: makeLink({ _id: "l_b" }), connection: b },
    ]);

    const secrets = collectKnownSecrets(servers);
    expect(secrets).toContain("secret_aaaa11112222");
    expect(secrets).toContain("secret_bbbb33334444");
    expect(secrets).toHaveLength(2);
  });

  it("returns empty for no servers", () => {
    expect(collectKnownSecrets([])).toEqual([]);
  });
});
