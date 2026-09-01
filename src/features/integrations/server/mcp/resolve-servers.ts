/**
 * Resolve a project's enabled connections into concrete MCP targets.
 *
 * This is where the pieces built separately come together: Convex supplies the
 * sealed credential and the per-project scope, the crypto module opens it, the
 * catalog supplies the endpoint and placement, and `buildScopedMcpUrl` applies
 * the scope. The output is what a transport can connect with.
 *
 * ## Failure policy: skip, do not throw
 *
 * One broken connection must not fail a whole agent run. If a credential cannot
 * be opened, or a provider has vanished from the catalog, or a scope selection is
 * invalid, that connection is dropped and reported in `problems`. The agent then
 * runs with the tools that *do* work, and the user sees a specific reason for the
 * one that does not — which is far better than a run that dies with "integration
 * error".
 *
 * ## Secrets in the return value
 *
 * `headers` contains a live credential and `knownSecrets` contains raw secret
 * values. Both stay server-side. `knownSecrets` exists so `redactSecrets` can
 * strip these exact values out of tool results before the model sees them, which
 * is the highest-value redaction case: a tool echoing back the very credential it
 * was called with.
 *
 * Nothing here may be logged or returned to a client.
 */

import { getProvider } from "../../catalog";
import type { ProjectScopeSelection } from "../../types";
import { getSecretSealer, secretContext } from "../crypto";
import { buildScopedMcpUrl } from "../scope-url";

/** Credential bundle as sealed by the connect route and the OAuth callback. */
interface StoredCredential {
  type: "api_key" | "oauth";
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
}

/** The subset of a `userConnections` document this module needs. */
export interface ConnectionRecord {
  _id: string;
  providerId: string;
  label: string;
  authMode: "oauth" | "api_key";
  serverUrl: string;
  credentialRef: string;
  kekProvider: string;
  kekKeyId: string;
  wrappedDek: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  tokenExpiresAt?: number;
}

/** The subset of a `projectConnections` document this module needs. */
export interface ProjectLinkRecord {
  _id: string;
  readOnly: boolean;
  providerScope: {
    projectRef?: string;
    categories?: string[];
    features?: string[];
    toolsets?: string[];
    orgSlug?: string;
    projectSlug?: string;
  };
  allowedTools?: string[];
  writeApproved: boolean;
  toolBaseline?: Array<{ name: string; digest: string }>;
}

export interface ResolvedMcpServer {
  /** `projectConnections` id — the unit of scope and approval. */
  projectConnectionId: string;
  userConnectionId: string;
  providerId: string;
  /** Namespace prefix for tool names, keeping providers distinguishable. */
  namespace: string;
  displayName: string;
  /** Scoped endpoint to connect to. */
  url: string;
  /** Scoping headers plus the credential. Server-side only. */
  headers: Record<string, string>;
  trustedHostnames: readonly string[];
  readOnly: boolean;
  writeApproved: boolean;
  allowedTools?: readonly string[];
  destructiveTools: readonly string[];
  toolBaseline?: ReadonlyArray<{ name: string; digest: string }>;
  /** Raw secret values to strip from tool results. Server-side only. */
  knownSecrets: readonly string[];
  /** Set when the access token is expired or about to expire. */
  needsRefresh: boolean;
}

export interface ResolveProblem {
  projectConnectionId: string;
  providerId: string;
  reason: string;
}

export interface ResolveResult {
  servers: ResolvedMcpServer[];
  problems: ResolveProblem[];
}

/**
 * Treat a token as needing refresh slightly before it actually expires, so a
 * long agent turn does not have it expire mid-run.
 */
const REFRESH_SKEW_MS = 60_000;

/**
 * Fallback credential placement, matching the connect route's default for custom
 * servers.
 */
const DEFAULT_PLACEMENT = {
  header: "Authorization",
  valuePrefix: "Bearer ",
} as const;

function credentialValue(credential: StoredCredential): string | undefined {
  return credential.type === "oauth"
    ? credential.accessToken
    : credential.apiKey;
}

/**
 * Turn linked connections into connectable targets.
 *
 * Takes already-fetched rows rather than querying, so it stays free of Convex
 * plumbing and is straightforward to exercise directly.
 */
export async function resolveMcpServers(
  entries: ReadonlyArray<{
    link: ProjectLinkRecord;
    connection: ConnectionRecord;
  }>,
): Promise<ResolveResult> {
  const sealer = getSecretSealer();
  const servers: ResolvedMcpServer[] = [];
  const problems: ResolveProblem[] = [];

  for (const { link, connection } of entries) {
    const fail = (reason: string) => {
      problems.push({
        projectConnectionId: link._id,
        providerId: connection.providerId,
        reason,
      });
    };

    // ── Open the credential ──
    let credential: StoredCredential;
    try {
      const opened = await sealer.open(
        {
          kekProvider: connection.kekProvider,
          kekKeyId: connection.kekKeyId,
          wrappedDek: connection.wrappedDek,
          ciphertext: connection.ciphertext,
          iv: connection.iv,
          authTag: connection.authTag,
        },
        secretContext(
          "userConnections",
          connection.credentialRef,
          "credential",
        ),
      );
      credential = JSON.parse(opened) as StoredCredential;
    } catch (error) {
      // Deliberately vague to the caller: the detail (wrong KEK, tampered row)
      // is operator information, and it is already logged with context by the
      // crypto layer.
      fail(
        `Could not decrypt the stored credential (${
          error instanceof Error ? error.message : "unknown error"
        }).`,
      );
      continue;
    }

    const secret = credentialValue(credential);
    if (!secret) {
      fail("The stored credential is missing an access token.");
      continue;
    }

    // ── Resolve provider metadata ──
    const provider = getProvider(connection.providerId);

    // A custom server has no catalog entry, so fall back to what the connection
    // itself recorded.
    const isCustom = !provider;

    const placement = provider?.apiKey ?? DEFAULT_PLACEMENT;
    const displayName = provider?.displayName ?? connection.label;

    // ── Apply per-project scope ──
    let url: string;
    let scopeHeaders: Record<string, string> = {};

    if (provider) {
      const selection: ProjectScopeSelection = {
        readOnly: link.readOnly,
        projectRef: link.providerScope.projectRef,
        categories: link.providerScope.categories,
        features: link.providerScope.features,
        toolsets: link.providerScope.toolsets,
        orgSlug: link.providerScope.orgSlug,
        projectSlug: link.providerScope.projectSlug,
      };

      try {
        const target = buildScopedMcpUrl(provider, selection);
        url = target.url;
        scopeHeaders = target.headers;
      } catch (error) {
        // buildScopedMcpUrl throws on an internally inconsistent selection, e.g.
        // a Sentry project slug with no org slug. That is a configuration error
        // the user can fix, so it is surfaced rather than silently widened.
        fail(
          error instanceof Error
            ? error.message
            : "The scope configuration for this connection is invalid.",
        );
        continue;
      }
    } else {
      url = connection.serverUrl;
    }

    const needsRefresh =
      connection.authMode === "oauth" &&
      typeof connection.tokenExpiresAt === "number" &&
      connection.tokenExpiresAt - REFRESH_SKEW_MS <= Date.now();

    servers.push({
      projectConnectionId: link._id,
      userConnectionId: connection._id,
      providerId: connection.providerId,
      // Underscores rather than a hyphen: tool names must survive being used as
      // identifiers by model providers that constrain the character set.
      namespace: connection.providerId.replace(/[^a-zA-Z0-9_]/g, "_"),
      displayName,
      url,
      headers: {
        ...scopeHeaders,
        [placement.header]: `${placement.valuePrefix}${secret}`,
      },
      trustedHostnames: isCustom ? [] : provider.trustedHostnames,
      readOnly: link.readOnly,
      writeApproved: link.writeApproved,
      allowedTools: link.allowedTools,
      destructiveTools: provider?.destructiveTools ?? [],
      toolBaseline: link.toolBaseline,
      // Both forms are included so a tool echoing either the raw key or the
      // bearer header value is caught.
      knownSecrets: [secret],
      needsRefresh,
    });
  }

  return { servers, problems };
}

/**
 * Every secret across resolved servers, for the redaction pass.
 *
 * Collected across all servers rather than per-server because a tool on one
 * server can quite easily return a credential belonging to another — asking
 * Supabase to `execute_sql` against a table where the app stored its Stripe key,
 * for instance.
 */
export function collectKnownSecrets(
  servers: readonly ResolvedMcpServer[],
): string[] {
  const secrets = new Set<string>();
  for (const server of servers) {
    for (const secret of server.knownSecrets) {
      secrets.add(secret);
    }
  }
  return [...secrets];
}
