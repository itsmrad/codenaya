import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { getProvider } from "@/features/integrations/catalog";
import {
  getSecretSealer,
  secretContext,
} from "@/features/integrations/server/crypto";
import { startOAuthFlow } from "@/features/integrations/server/oauth/flow";
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

/**
 * Absolute callback URL.
 *
 * Must match exactly what was registered with the authorization server, so it is
 * read from configuration rather than derived from the request — a request-derived
 * value would vary across preview deployments and silently break the redirect_uri
 * match.
 */
function resolveRedirectUri(): string | undefined {
  const explicit = process.env.INTEGRATIONS_REDIRECT_URI;
  if (explicit) return explicit;

  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : undefined);

  return appUrl ? `${appUrl}/api/integrations/oauth/callback` : undefined;
}

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return jsonError("Unauthorized", 401);
  }

  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
  if (!internalKey) {
    console.error("[oauth/start] CODENAYA_CONVEX_INTERNAL_KEY is not set");
    return jsonError("Server is not configured for integrations", 500);
  }

  const redirectUri = resolveRedirectUri();
  if (!redirectUri) {
    return jsonError(
      "OAuth is not configured. Set INTEGRATIONS_REDIRECT_URI to the absolute " +
        "callback URL for this deployment.",
      500,
    );
  }

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
