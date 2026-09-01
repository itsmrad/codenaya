/**
 * Authorization-server origin validation.
 *
 * ## The attack this prevents
 *
 * OAuth discovery asks the *MCP server* where its authorization server lives
 * (RFC 9728). That means a hostile or compromised MCP server chooses who we send
 * the user to authenticate with. Left unchecked, a server at
 * `https://evil.example.com/mcp` could nominate
 * `https://login.evil.example.com` as its authorization server, and we would
 * dutifully redirect the user there, register a client, and hand over an
 * authorization code.
 *
 * The AI SDK documents this as the reason `validateAuthorizationServerURL`
 * exists: connect only to authorization server origins you trust. This module is
 * that check.
 *
 * ## The policy
 *
 * 1. HTTPS is required. An authorization code over plaintext is a leaked
 *    credential.
 * 2. If the catalog declares `trustedAuthorizationServerOrigins` for the
 *    provider, the discovered origin must be one of them. Exact match, no
 *    wildcards.
 * 3. Otherwise the discovered origin must be *same-site* with the MCP server —
 *    it must be the MCP host's parent domain or a subdomain of it. So
 *    `mcp.supabase.com` may nominate `supabase.com` or `auth.supabase.com`, but
 *    not `supabase.com.evil.io` and not `github.com`.
 *
 * Rule 3 fails closed. A provider that legitimately uses a third-party identity
 * provider on a different domain will be rejected until its origin is added to
 * the catalog — which is the safe direction to be wrong in. The error names the
 * discovered origin so adding it is a small, deliberate change rather than a
 * debugging exercise.
 *
 * ## Why not derive the registrable domain properly
 *
 * Correctly computing eTLD+1 needs the Public Suffix List. Approximating it as
 * "last two labels" is actively dangerous: for `a.co.uk` it yields `co.uk`, which
 * would treat every `.co.uk` domain as same-site with every other. Stripping
 * exactly one label from the MCP host avoids that entirely — it can only ever be
 * more restrictive than the true registrable domain, never less.
 */

export type AsGuardResult =
  | { ok: true; origin: string }
  | { ok: false; reason: string };

/**
 * Derive the parent domain by removing the leftmost label.
 *
 * `mcp.supabase.com` → `supabase.com`
 * `api.githubcopilot.com` → `githubcopilot.com`
 * `example.com` → `example.com` (already at two labels; do not strip further)
 */
function parentDomain(hostname: string): string {
  const labels = hostname.split(".");
  if (labels.length <= 2) return hostname;
  return labels.slice(1).join(".");
}

/**
 * True when `hostname` is `base` or a subdomain of it.
 *
 * The leading-dot comparison is what stops `supabase.com.evil.io` from matching
 * `supabase.com` — a plain `endsWith` would accept it.
 */
function isSameSite(hostname: string, base: string): boolean {
  return hostname === base || hostname.endsWith(`.${base}`);
}

export interface ValidateAuthorizationServerOptions {
  /** The MCP server URL the authorization server was discovered from. */
  mcpServerUrl: string;
  /** Discovered authorization server URL. */
  authorizationServerUrl: string;
  /**
   * Catalog-declared origins for this provider. When present it is the only
   * thing consulted — the same-site fallback does not apply.
   */
  trustedOrigins?: readonly string[];
  /** For error messages. */
  providerDisplayName?: string;
}

export function validateAuthorizationServer(
  options: ValidateAuthorizationServerOptions,
): AsGuardResult {
  const {
    mcpServerUrl,
    authorizationServerUrl,
    trustedOrigins,
    providerDisplayName,
  } = options;

  let asUrl: URL;
  try {
    asUrl = new URL(authorizationServerUrl);
  } catch {
    return {
      ok: false,
      reason: `Discovered authorization server is not a valid URL: "${authorizationServerUrl}".`,
    };
  }

  if (asUrl.protocol !== "https:") {
    return {
      ok: false,
      reason: `Authorization server must use https, got "${asUrl.protocol}".`,
    };
  }

  const origin = asUrl.origin;

  if (trustedOrigins && trustedOrigins.length > 0) {
    if (!trustedOrigins.includes(origin)) {
      return {
        ok: false,
        reason:
          `Authorization server "${origin}" is not in the trusted list for ` +
          `${providerDisplayName ?? "this provider"} ` +
          `(${trustedOrigins.join(", ")}).`,
      };
    }
    return { ok: true, origin };
  }

  let mcpUrl: URL;
  try {
    mcpUrl = new URL(mcpServerUrl);
  } catch {
    return {
      ok: false,
      reason: `MCP server URL is not valid: "${mcpServerUrl}".`,
    };
  }

  const base = parentDomain(mcpUrl.hostname);

  if (!isSameSite(asUrl.hostname, base)) {
    return {
      ok: false,
      reason:
        `The MCP server at "${mcpUrl.hostname}" nominated authorization server ` +
        `"${origin}", which is not under "${base}". Refusing to send the user there. ` +
        `If this is legitimate, add "${origin}" to the provider's ` +
        `trustedAuthorizationServerOrigins in the catalog.`,
    };
  }

  return { ok: true, origin };
}
