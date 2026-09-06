import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { getProvider } from "@/features/integrations/catalog";
import {
  getSecretSealer,
  secretContext,
} from "@/features/integrations/server/crypto";
import { startOAuthFlow } from "@/features/integrations/server/oauth/flow";
import {
  OAUTH_START_RATE_LIMIT,
  checkRateLimit,
  rateLimitedResponse,
} from "@/features/integrations/server/rate-limit";
import { convex } from "@/lib/convex-client";

import { api } from "../../../../../../convex/_generated/api";

/**
 * POST /api/integrations/oauth/start
 *
 * First leg of the OAuth 2.1 flow. Discovers the provider's authorization
 * server, registers a client, persists the sealed PKCE verifier, and returns the
 * URL to send the user to.
 *
 * Returns the URL rather than issuing a 302 so the client can open it in a popup
 * and keep the editor mounted — a full-page redirect out of a project would lose
 * unsaved editor state.
 */

const requestSchema = z.object({
  providerId: z.string().min(1),
});

function jsonError(error: string, status: number) {
  return Response.json({ ok: false, error }, { status });
}

/** Path the callback route is served at. Must match the file location. */
const CALLBACK_PATH = "/api/integrations/oauth/callback";

/**
 * Placeholder hostnames that appear in this project's own documentation.
 *
 * Checked explicitly because pasting one verbatim is an easy mistake and its symptom
 * is confusing: the OAuth flow *succeeds*, the provider redirects to a domain that
 * does not exist, and the user sees a browser error with no connection to this
 * configuration.
 */
const PLACEHOLDER_HOSTS = [
  "your-domain.com",
  "www.your-domain.com",
  "example.com",
  "your-app.vercel.app",
];

/**
 * Absolute callback URL.
 *
 * Must match exactly what was registered with the authorization server, so it is
 * read from configuration rather than derived from the request — a request-derived
 * value would vary across preview deployments and would also let a caller influence
 * where an authorization code is sent.
 *
 * Returns a reason string on failure so the route can explain what to fix, rather
 * than a bare undefined that becomes a generic error.
 */
function resolveRedirectUri():
  | { ok: true; redirectUri: string }
  | { ok: false; reason: string } {
  const explicit = process.env.INTEGRATIONS_REDIRECT_URI;

  const candidate =
    explicit ??
    (() => {
      const appUrl =
        process.env.NEXT_PUBLIC_APP_URL ??
        (process.env.VERCEL_PROJECT_PRODUCTION_URL
          ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
          : undefined);
      return appUrl ? `${appUrl}${CALLBACK_PATH}` : undefined;
    })();

  if (!candidate) {
    return {
      ok: false,
      reason:
        "OAuth is not configured. Set INTEGRATIONS_REDIRECT_URI to this deployment's " +
        `absolute callback URL, e.g. http://localhost:3000${CALLBACK_PATH} for local ` +
        "development.",
    };
  }

  let url: URL;
  try {
    url = new URL(candidate.trim());
  } catch {
    return {
      ok: false,
      reason: `INTEGRATIONS_REDIRECT_URI is not a valid absolute URL: "${candidate}".`,
    };
  }

  if (PLACEHOLDER_HOSTS.includes(url.hostname)) {
    return {
      ok: false,
      reason:
        `INTEGRATIONS_REDIRECT_URI still points at the documentation placeholder ` +
        `"${url.hostname}". Replace it with this deployment's real host — ` +
        `http://localhost:3000${CALLBACK_PATH} for local development — and restart ` +
        `the dev server so the new value is picked up.`,
    };
  }

  if (url.pathname !== CALLBACK_PATH) {
    // A wrong path fails at the provider with an opaque redirect_uri_mismatch,
    // which is far harder to diagnose than saying so here.
    return {
      ok: false,
      reason:
        `INTEGRATIONS_REDIRECT_URI must end with "${CALLBACK_PATH}", got ` +
        `"${url.pathname}".`,
    };
  }

  // Loopback HTTP is permitted by OAuth 2.1 and is how local development works.
  // Anything else on plaintext would send an authorization code in the clear.
  const isLoopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";

  if (url.protocol !== "https:" && !isLoopback) {
    return {
      ok: false,
      reason:
        `INTEGRATIONS_REDIRECT_URI must use https except on localhost, got ` +
        `"${url.protocol}//${url.hostname}".`,
    };
  }

  return { ok: true, redirectUri: url.toString() };
}

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return jsonError("Unauthorized", 401);
  }

  // Each attempt performs OAuth discovery and registers a fresh client with the
  // provider, which is slow and something they may throttle against our account
  // rather than the user's.
  const rateLimit = checkRateLimit(userId, OAUTH_START_RATE_LIMIT);
  if (!rateLimit.allowed) {
    return rateLimitedResponse(rateLimit);
  }

  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
  if (!internalKey) {
    console.error("[oauth/start] CODENAYA_CONVEX_INTERNAL_KEY is not set");
    return jsonError("Server is not configured for integrations", 500);
  }

  const redirect = resolveRedirectUri();
  if (!redirect.ok) {
    return jsonError(redirect.reason, 500);
  }
  const redirectUri = redirect.redirectUri;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be JSON", 400);
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "Invalid request", 400);
  }

  const provider = getProvider(parsed.data.providerId);
  if (!provider) {
    return jsonError(`Unknown provider "${parsed.data.providerId}"`, 400);
  }

  if (!provider.authModes.includes("oauth")) {
    return jsonError(
      `${provider.displayName} does not support OAuth. Connect it with an API key instead.`,
      400,
    );
  }

  const result = await startOAuthFlow({ provider, redirectUri });
  if (!result.ok) {
    // Discovery and client-registration failures are provider-side, not our bug,
    // so 502 rather than 500. The message is already actionable.
    return jsonError(result.error, 502);
  }

  const { start } = result;

  // The PKCE verifier is the secret half of the exchange: a leaked verifier plus
  // an intercepted code is enough to steal the token. It gets the same envelope
  // treatment as the tokens, anchored on `state` — which is generated before the
  // insert, so this is a single write.
  //
  // The client credentials from dynamic registration ride along in the same blob
  // because they are needed together at exchange time and a registration may
  // include a client secret.
  let sealed;
  try {
    sealed = await getSecretSealer().seal(
      JSON.stringify({
        codeVerifier: start.codeVerifier,
        clientInformation: start.clientInformation,
      }),
      secretContext("oauthFlowStates", start.state, "pkce"),
    );
  } catch (error) {
    console.error("[oauth/start] failed to seal flow state", error);
    return jsonError(
      "Could not securely start the authorization flow. Check server configuration.",
      500,
    );
  }

  try {
    await convex.mutation(api.system.createOauthFlowState, {
      internalKey,
      state: start.state,
      userId,
      providerId: provider.id,
      serverUrl: provider.mcpUrl,
      redirectUri,
      authServerUrl: start.authorizationServerUrl,
      issuer: start.issuer,
      expiresAt: start.expiresAt,
      ...sealed,
    });
  } catch (error) {
    console.error("[oauth/start] failed to persist flow state", error);
    return jsonError("Could not start the authorization flow", 500);
  }

  return Response.json({
    ok: true,
    authorizationUrl: start.authorizationUrl,
    provider: { id: provider.id, displayName: provider.displayName },
    expiresAt: start.expiresAt,
  });
}
