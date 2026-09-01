/**
 * OAuth 2.1 authorization-code flow with PKCE and dynamic client registration.
 *
 * ## Why the low-level SDK functions instead of `auth()`
 *
 * The MCP SDK's `auth()` orchestrator assumes an interactive client that can
 * redirect and keep state in memory. We are a web server: the user leaves for the
 * provider's consent screen and comes back in a *different request*, so the PKCE
 * verifier has to be persisted across that gap. Composing
 * `discoverOAuthServerInfo` → `registerClient` → `startAuthorization` →
 * `exchangeAuthorization` gives us control over where that state lives and lets
 * us seal it.
 *
 * ## What is stored between the two legs
 *
 * A row in `oauthFlowStates`, keyed by an unguessable `state`, holding the sealed
 * PKCE verifier and client credentials. It is single-use and short-lived:
 *
 * - **Single use** — deleted the moment the callback consumes it, so an
 *   intercepted authorization code cannot be replayed against the same verifier.
 * - **Short-lived** — a 10-minute TTL bounds how long a leaked `state` is worth
 *   anything.
 * - **Sealed** — the verifier is the secret half of PKCE. A leaked verifier plus
 *   an intercepted code is enough to steal the token, so it gets the same
 *   envelope encryption as the tokens themselves.
 *
 * ## Cross-check on the way back
 *
 * The callback verifies three things beyond the code exchange itself: that the
 * `state` exists and has not expired, that it belongs to the *currently
 * signed-in* user, and that the `iss` parameter matches the issuer recorded at
 * start. The last one is the OAuth mix-up defence — without it, a malicious
 * authorization server can trick a client into exchanging a code at the wrong
 * token endpoint.
 */

import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { nanoid } from "nanoid";

import type { ProviderDefinition } from "../../types";
import { createGuardedFetch } from "../mcp/guarded-fetch";
import { validateAuthorizationServer } from "./as-guard";

/** How long an in-flight authorization may sit before it is useless. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Client metadata sent during dynamic client registration (RFC 7591).
 *
 * `token_endpoint_auth_method: "none"` because we are a public client using PKCE
 * — there is no client secret to protect, and PKCE is what binds the code to this
 * flow.
 *
 * Note: RFC 7591 also defines `application_type`, which the AI SDK docs mention
 * for distinguishing native from web clients. This SDK version's
 * `OAuthClientMetadata` schema does not include that field, so it is omitted
 * rather than cast past the type — the redirect URI is an HTTPS URL, so servers
 * that care will infer a web client anyway.
 */
function clientMetadataFor(redirectUri: string): OAuthClientMetadata {
  return {
    client_name: "Codenaya",
    client_uri: "https://codenaya.com",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

export interface OAuthFlowStart {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
  authorizationServerUrl: string;
  /** Recorded so the callback can reject an `iss` mismatch. */
  issuer?: string;
  clientInformation: OAuthClientInformationFull;
  expiresAt: number;
}

export type StartOAuthResult =
  | { ok: true; start: OAuthFlowStart }
  | { ok: false; error: string };

export interface StartOAuthOptions {
  provider: ProviderDefinition;
  redirectUri: string;
}

/**
 * First leg: discover, register a client, and build the authorization URL.
 *
 * Returns everything the caller must persist before redirecting the user. This
 * function performs no I/O against our own database, which keeps it testable and
 * keeps the sealing decision with the caller.
 */
export async function startOAuthFlow(
  options: StartOAuthOptions,
): Promise<StartOAuthResult> {
  const { provider, redirectUri } = options;

  // Discovery talks to a remote server, so it goes through the guarded fetch for
  // the same SSRF reasons as any other outbound MCP request.
  const fetchFn = createGuardedFetch({
    trustedHosts: provider.trustedHostnames,
  });

  let serverInfo;
  try {
    serverInfo = await discoverOAuthServerInfo(provider.mcpUrl, { fetchFn });
  } catch (error) {
    return {
      ok: false,
      error:
        `Could not discover OAuth configuration for ${provider.displayName}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // The critical gate: the MCP server told us where to send the user, and we do
  // not take its word for it.
  const asVerdict = validateAuthorizationServer({
    mcpServerUrl: provider.mcpUrl,
    authorizationServerUrl: serverInfo.authorizationServerUrl,
    trustedOrigins: provider.trustedAuthorizationServerOrigins,
    providerDisplayName: provider.displayName,
  });

  if (!asVerdict.ok) {
    return { ok: false, error: asVerdict.reason };
  }

  const metadata: AuthorizationServerMetadata | undefined =
    serverInfo.authorizationServerMetadata;

  const scope = provider.oauthScopes?.length
    ? provider.oauthScopes.join(" ")
    : undefined;

  let clientInformation: OAuthClientInformationFull;
  try {
    clientInformation = await registerClient(serverInfo.authorizationServerUrl, {
      metadata,
      clientMetadata: clientMetadataFor(redirectUri),
      scope,
      fetchFn,
    });
  } catch (error) {
    // Not every authorization server supports RFC 7591. When it does not, an
    // operator must pre-register a client and supply its id — surfaced here
    // rather than as an opaque failure.
    return {
      ok: false,
      error:
        `${provider.displayName} did not accept dynamic client registration ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        `This provider needs a pre-registered OAuth client.`,
    };
  }

  const state = nanoid(32);

  let authorization;
  try {
    authorization = await startAuthorization(
      serverInfo.authorizationServerUrl,
      {
        metadata,
        clientInformation,
        redirectUrl: redirectUri,
        scope,
        state,
        // RFC 8707 resource indicator. Binds the issued token to this MCP
        // server so it cannot be replayed against a different resource.
        resource: new URL(provider.mcpUrl),
      },
    );
  } catch (error) {
    return {
      ok: false,
      error:
        `Could not build an authorization request for ${provider.displayName}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return {
    ok: true,
    start: {
      authorizationUrl: authorization.authorizationUrl.toString(),
      state,
      codeVerifier: authorization.codeVerifier,
      authorizationServerUrl: serverInfo.authorizationServerUrl,
      issuer: metadata?.issuer,
      clientInformation,
      expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
    },
  };
}

export interface CompleteOAuthOptions {
  provider: ProviderDefinition;
  authorizationServerUrl: string;
  authorizationCode: string;
  codeVerifier: string;
  redirectUri: string;
  clientInformation: OAuthClientInformationFull;
  /** `iss` from the callback, when the server sent one. */
  callbackIssuer?: string;
  /** Issuer recorded at start, for the mix-up check. */
  expectedIssuer?: string;
}

export type CompleteOAuthResult =
  | { ok: true; tokens: OAuthTokens }
  | { ok: false; error: string };

/**
 * Second leg: verify the issuer, then exchange the code for tokens.
 *
 * The issuer check happens *before* the exchange. Once a code is sent to the
 * wrong token endpoint the damage is done, so validating afterwards would be too
 * late.
 */
export async function completeOAuthFlow(
  options: CompleteOAuthOptions,
): Promise<CompleteOAuthResult> {
  const {
    provider,
    authorizationServerUrl,
    authorizationCode,
    codeVerifier,
    redirectUri,
    clientInformation,
    callbackIssuer,
    expectedIssuer,
  } = options;

  if (callbackIssuer && expectedIssuer && callbackIssuer !== expectedIssuer) {
    return {
      ok: false,
      error:
        "The authorization response came from a different issuer than the one we " +
        "started with. Refusing to exchange the code.",
    };
  }

  const fetchFn = createGuardedFetch({
    trustedHosts: provider.trustedHostnames,
  });

  // Re-validate the origin. The stored value came from our own row, but
  // re-checking costs nothing and means a tampered row cannot redirect the token
  // request somewhere else.
  const asVerdict = validateAuthorizationServer({
    mcpServerUrl: provider.mcpUrl,
    authorizationServerUrl,
    trustedOrigins: provider.trustedAuthorizationServerOrigins,
    providerDisplayName: provider.displayName,
  });

  if (!asVerdict.ok) {
    return { ok: false, error: asVerdict.reason };
  }

  try {
    const tokens = await exchangeAuthorization(authorizationServerUrl, {
      clientInformation,
      authorizationCode,
      codeVerifier,
      redirectUri,
      resource: new URL(provider.mcpUrl),
      fetchFn,
    });

    return { ok: true, tokens };
  } catch (error) {
    return {
      ok: false,
      error:
        `Token exchange failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export interface RefreshOAuthOptions {
  provider: ProviderDefinition;
  authorizationServerUrl: string;
  refreshToken: string;
  clientInformation: OAuthClientInformationFull;
}

/**
 * Exchange a refresh token for a fresh access token.
 *
 * The SDK preserves the existing refresh token when the server does not issue a
 * new one, so the caller can persist the result unconditionally.
 */
export async function refreshOAuthTokens(
  options: RefreshOAuthOptions,
): Promise<CompleteOAuthResult> {
  const {
    provider,
    authorizationServerUrl,
    refreshToken,
    clientInformation,
  } = options;

  const asVerdict = validateAuthorizationServer({
    mcpServerUrl: provider.mcpUrl,
    authorizationServerUrl,
    trustedOrigins: provider.trustedAuthorizationServerOrigins,
    providerDisplayName: provider.displayName,
  });

  if (!asVerdict.ok) {
    return { ok: false, error: asVerdict.reason };
  }

  try {
    const tokens = await refreshAuthorization(authorizationServerUrl, {
      clientInformation,
      refreshToken,
      resource: new URL(provider.mcpUrl),
      fetchFn: createGuardedFetch({
        trustedHosts: provider.trustedHostnames,
      }),
    });

    return { ok: true, tokens };
  } catch (error) {
    return {
      ok: false,
      error:
        `Token refresh failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Absolute expiry from a token response's relative `expires_in`.
 *
 * Returns undefined when the server omits it, which means "no known expiry" —
 * treated as never proactively refreshing rather than as immediately expired.
 */
export function tokenExpiryFrom(tokens: OAuthTokens): number | undefined {
  return typeof tokens.expires_in === "number"
    ? Date.now() + tokens.expires_in * 1000
    : undefined;
}
