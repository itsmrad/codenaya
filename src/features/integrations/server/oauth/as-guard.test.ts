import { describe, expect, it } from "vitest";

import { validateAuthorizationServer } from "./as-guard";

/**
 * These tests pin the boundary that stops a hostile MCP server from choosing
 * where we send the user to authenticate. OAuth discovery lets the *resource
 * server* nominate its authorization server, so without this check a malicious
 * server could harvest authorization codes.
 */

const SUPABASE_MCP = "https://mcp.supabase.com/mcp";

describe("same-site fallback (no catalog origins declared)", () => {
  it("accepts the MCP host's parent domain", () => {
    const result = validateAuthorizationServer({
      mcpServerUrl: SUPABASE_MCP,
      authorizationServerUrl: "https://supabase.com",
    });
    expect(result).toEqual({ ok: true, origin: "https://supabase.com" });
  });

  it("accepts a sibling subdomain of the parent domain", () => {
    const result = validateAuthorizationServer({
      mcpServerUrl: SUPABASE_MCP,
      authorizationServerUrl: "https://auth.supabase.com/authorize",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts the MCP host itself acting as the authorization server", () => {
    const result = validateAuthorizationServer({
      mcpServerUrl: SUPABASE_MCP,
      authorizationServerUrl: "https://mcp.supabase.com",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an unrelated domain", () => {
    const result = validateAuthorizationServer({
      mcpServerUrl: SUPABASE_MCP,
      authorizationServerUrl: "https://login.evil.example.com",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not under "supabase\.com"/);
      // The message must name the origin so an operator can allowlist it
      // deliberately rather than having to reverse-engineer the failure.
      expect(result.reason).toContain("https://login.evil.example.com");
      expect(result.reason).toMatch(/trustedAuthorizationServerOrigins/);
    }
  });

  it("rejects a suffix-confusion domain", () => {
    // The classic bypass: a plain endsWith("supabase.com") check would accept
    // this, handing authorization codes to evil.io.
    const result = validateAuthorizationServer({
      mcpServerUrl: SUPABASE_MCP,
      authorizationServerUrl: "https://supabase.com.evil.io",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a domain that merely contains the base as a substring", () => {
    const result = validateAuthorizationServer({
      mcpServerUrl: SUPABASE_MCP,
      authorizationServerUrl: "https://notsupabase.com",
    });
    expect(result.ok).toBe(false);
  });

  it("strips exactly one label, never guessing at eTLD+1", () => {
    // For a host on a multi-part public suffix, stripping one label yields
    // "example.co.uk" rather than "co.uk". Being over-restrictive here is safe;
    // approximating the registrable domain as the last two labels would treat
    // every .co.uk site as same-site with every other.
    const ok = validateAuthorizationServer({
      mcpServerUrl: "https://mcp.example.co.uk/mcp",
      authorizationServerUrl: "https://auth.example.co.uk",
    });
    expect(ok.ok).toBe(true);

    const blocked = validateAuthorizationServer({
      mcpServerUrl: "https://mcp.example.co.uk/mcp",
      authorizationServerUrl: "https://attacker.co.uk",
    });
    expect(blocked.ok).toBe(false);
  });

  it("does not strip below two labels", () => {
    const result = validateAuthorizationServer({
      mcpServerUrl: "https://example.com/mcp",
      authorizationServerUrl: "https://example.com",
    });
    expect(result.ok).toBe(true);

    // If the implementation stripped a label here it would compare against
    // "com" and accept anything.
    const blocked = validateAuthorizationServer({
      mcpServerUrl: "https://example.com/mcp",
      authorizationServerUrl: "https://attacker.com",
    });
    expect(blocked.ok).toBe(false);
  });

  it("rejects GitHub's cross-domain authorization server without an override", () => {
    // Documents real expected behaviour: api.githubcopilot.com almost certainly
    // authenticates via github.com, which is a different registrable domain. It
    // must fail closed until the catalog declares it.
    const result = validateAuthorizationServer({
      mcpServerUrl: "https://api.githubcopilot.com/mcp/",
      authorizationServerUrl: "https://github.com",
      providerDisplayName: "GitHub",
    });
    expect(result.ok).toBe(false);
  });
});

describe("explicit trusted origins", () => {
  it("accepts an exactly matching origin", () => {
    const result = validateAuthorizationServer({
      mcpServerUrl: "https://api.githubcopilot.com/mcp/",
      authorizationServerUrl: "https://github.com/login/oauth",
      trustedOrigins: ["https://github.com"],
      providerDisplayName: "GitHub",
    });
    expect(result).toEqual({ ok: true, origin: "https://github.com" });
  });

  it("overrides the same-site rule entirely", () => {
    // Cross-domain is fine when declared: that is the point of the override.
    const result = validateAuthorizationServer({
      mcpServerUrl: "https://mcp.example.com/mcp",
      authorizationServerUrl: "https://tenant.auth0.com",
      trustedOrigins: ["https://tenant.auth0.com"],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects anything not listed, even if same-site", () => {
    // An explicit list is a closed set. A same-site origin that is not on it is
    // still refused, so the list is a real constraint rather than a hint.
    const result = validateAuthorizationServer({
      mcpServerUrl: "https://mcp.example.com/mcp",
      authorizationServerUrl: "https://auth.example.com",
      trustedOrigins: ["https://tenant.auth0.com"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not in the trusted list/);
  });

  it("compares origin only, ignoring path", () => {
    const result = validateAuthorizationServer({
      mcpServerUrl: "https://mcp.example.com/mcp",
      authorizationServerUrl: "https://auth.example.com/oauth/authorize?x=1",
      trustedOrigins: ["https://auth.example.com"],
    });
    expect(result).toEqual({ ok: true, origin: "https://auth.example.com" });
  });

  it("treats a non-default port as part of the origin", () => {
    const result = validateAuthorizationServer({
      mcpServerUrl: "https://mcp.example.com/mcp",
      authorizationServerUrl: "https://auth.example.com:8443",
      trustedOrigins: ["https://auth.example.com"],
    });
    expect(result.ok).toBe(false);
  });

  it("falls back to same-site when the list is empty", () => {
    const result = validateAuthorizationServer({
      mcpServerUrl: SUPABASE_MCP,
      authorizationServerUrl: "https://auth.supabase.com",
      trustedOrigins: [],
    });
    expect(result.ok).toBe(true);
  });
});

describe("transport and input validation", () => {
  it("rejects a plaintext authorization server", () => {
    // An authorization code travelling over http is a leaked credential.
    const result = validateAuthorizationServer({
      mcpServerUrl: SUPABASE_MCP,
      authorizationServerUrl: "http://supabase.com",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/must use https/);
  });

  it("rejects http even when explicitly trusted", () => {
    const result = validateAuthorizationServer({
      mcpServerUrl: SUPABASE_MCP,
      authorizationServerUrl: "http://supabase.com",
      trustedOrigins: ["http://supabase.com"],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects non-http schemes", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x"]) {
      const result = validateAuthorizationServer({
        mcpServerUrl: SUPABASE_MCP,
        authorizationServerUrl: url,
      });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects a malformed authorization server URL", () => {
    const result = validateAuthorizationServer({
      mcpServerUrl: SUPABASE_MCP,
      authorizationServerUrl: "not a url",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not a valid URL/);
  });

  it("rejects a malformed MCP server URL", () => {
    const result = validateAuthorizationServer({
      mcpServerUrl: "!!!",
      authorizationServerUrl: "https://supabase.com",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/MCP server URL is not valid/);
  });
});
