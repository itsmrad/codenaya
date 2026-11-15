import { auth } from "@clerk/nextjs/server";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { nanoid } from "nanoid";

import { getProvider, resolveProviderMcpUrl } from "@/features/integrations/catalog";
import { maskCredential } from "@/features/integrations/env-keys";
import {
  getSecretSealer,
  secretContext,
} from "@/features/integrations/server/crypto";
import {
  completeOAuthFlow,
  tokenExpiryFrom,
} from "@/features/integrations/server/oauth/flow";
import { convex } from "@/lib/convex-client";

import { api } from "../../../../../../convex/_generated/api";

/**
 * GET /api/integrations/oauth/callback
 *
 * Second leg of the OAuth flow. The provider redirects the user here with an
 * authorization code, which is exchanged for tokens and stored sealed.
 *
 * ## Why this returns HTML rather than a redirect
 *
 * The flow is started in a popup so the editor stays mounted. The popup has to
 * close itself and tell the opener what happened, which needs a document — a 302
 * would leave the user staring at the app in a stray window.
 */

/**
 * Minimal self-closing page that reports the outcome to the opener.
 *
 * The `postMessage` target origin is the popup's own `location.origin`, never
 * `*`, so the result cannot be read by another window. It is read in the browser
 * rather than from `request.url`, which under `next dev` is `0.0.0.0` and never
 * matches the opener.
 *
 * `message` can carry provider-supplied text, so it is HTML-escaped for the page
 * and, in the script, JSON-encoded with `<`, `>`, `&`, U+2028 and U+2029 escaped:
 * plain `JSON.stringify` would let `</script>` close the block (#222).
 */
function resultPage(status: "success" | "error", message: string): Response {
  const payload = JSON.stringify({
    source: "codenaya-oauth",
    status,
    message,
  }).replace(
    /[<>&\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${status === "success" ? "Connected" : "Connection failed"}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; display: grid; place-items: center;
         min-height: 100vh; margin: 0; background: #0b0b0c; color: #e8e8ea; }
  main { max-width: 28rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1rem; margin: 0 0 .5rem; }
  p { font-size: .8125rem; color: #a1a1aa; margin: 0; line-height: 1.5; }
</style>
</head>
<body>
<main>
  <h1>${status === "success" ? "Connected" : "Connection failed"}</h1>
  <p>${message.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] as string)}</p>
</main>
<script>
  try {
    if (window.opener) {
      window.opener.postMessage(${payload}, window.location.origin);
    }
  } catch (e) {}
  setTimeout(function () { window.close(); }, ${status === "success" ? 600 : 4000});
</script>
</body>
</html>`;

  return new Response(html, {
    status: status === "success" ? 200 : 400,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Nothing here should ever be cached: it carries flow-specific results.
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);

  const fail = (message: string) => resultPage("error", message);

  const { userId } = await auth();
  if (!userId) {
    return fail("Your session expired. Sign in and try connecting again.");
  }

  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
  if (!internalKey) {
    console.error("[oauth/callback] CODENAYA_CONVEX_INTERNAL_KEY is not set");
    return fail("Server is not configured for integrations.");
  }

  // The provider reports user-facing denials here rather than as an HTTP error.
  const providerError = url.searchParams.get("error");
  if (providerError) {
    // Attacker-controllable via a crafted link, so it is only ever shown as
    // escaped text, and capped so it cannot flood the page.
    const description = (
      url.searchParams.get("error_description") ?? providerError
    ).slice(0, 300);
    return fail(`The provider declined the request: ${description}`);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const callbackIssuer = url.searchParams.get("iss") ?? undefined;

  if (!code || !state) {
    return fail("The provider's response was missing a code or state value.");
  }

  const flow = await convex.query(api.system.getOauthFlowState, {
    internalKey,
    state,
  });

  if (!flow) {
    // Either replayed, already consumed, or pruned. All three are indistinguishable
    // from here and all three mean: start again.
    return fail(
      "This authorization request is no longer valid. Please start again.",
    );
  }

  // Consume the row first, before any exchange attempt. Deleting up front makes
  // the state single-use even if the exchange fails or the handler crashes
  // mid-way, which is what prevents an intercepted code being replayed against
  // the same PKCE verifier.
  await convex.mutation(api.system.deleteOauthFlowState, {
    internalKey,
    stateId: flow._id,
  });

  if (flow.expiresAt <= Date.now()) {
    return fail("This authorization request expired. Please start again.");
  }

  // Binding the flow to the signed-in user stops a cross-user session fixation:
  // without it, an attacker could start a flow and have a victim complete it,
  // attaching the attacker's credential to the victim's account.
  if (flow.userId !== userId) {
    console.warn(
      "[oauth/callback] state belonged to a different user; refusing",
    );
    return fail("This authorization request belongs to a different account.");
  }

  const provider = getProvider(flow.providerId);
  if (!provider) {
    return fail(`Unknown provider "${flow.providerId}".`);
  }

  let connectionId: string | undefined;
  let codeVerifier: string;
  let clientInformation: OAuthClientInformationFull;
  let authorizationServerMetadata: AuthorizationServerMetadata | undefined;
  try {
    const opened = await getSecretSealer().open(
      {
        kekProvider: flow.kekProvider,
        kekKeyId: flow.kekKeyId,
        wrappedDek: flow.wrappedDek,
        ciphertext: flow.ciphertext,
        iv: flow.iv,
        authTag: flow.authTag,
      },
      secretContext("oauthFlowStates", flow.state, "pkce"),
    );
    const parsed = JSON.parse(opened) as {
      connectionId?: string;
      codeVerifier: string;
      clientInformation: OAuthClientInformationFull;
      authorizationServerMetadata?: AuthorizationServerMetadata;
    };
    connectionId = parsed.connectionId;
    codeVerifier = parsed.codeVerifier;
    clientInformation = parsed.clientInformation;
    authorizationServerMetadata = parsed.authorizationServerMetadata;
  } catch (error) {
    console.error("[oauth/callback] failed to open flow state", error);
    return fail("Could not verify the authorization request.");
  }

  const existing = connectionId ? await convex.query(api.system.getConnectionForReconnect, {
    internalKey, userId, connectionId, providerId: provider.id, authMode: "oauth",
  }) : null;
  if (connectionId && !existing) return fail("Connection not found. Please start again.");

  const exchange = await completeOAuthFlow({
    provider,
    authorizationServerUrl: flow.authServerUrl,
    authorizationServerMetadata,
    authorizationCode: code,
    codeVerifier,
    redirectUri: flow.redirectUri,
    clientInformation,
    callbackIssuer,
    expectedIssuer: flow.issuer ?? undefined,
  });

  if (!exchange.ok) {
    return fail(exchange.error);
  }

  const { tokens } = exchange;

  const credentialRef = existing?.credentialRef ?? nanoid();

  let sealed;
  try {
    sealed = await getSecretSealer().seal(
      JSON.stringify({
        type: "oauth",
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenType: tokens.token_type,
        // Kept so a refresh can re-present the same client identity.
        clientInformation,
        // Refresh requests need the advertised token endpoint for the same
        // reason as the initial exchange.
        authorizationServerMetadata,
      }),
      secretContext("userConnections", credentialRef, "credential"),
    );
  } catch (error) {
    console.error("[oauth/callback] failed to seal tokens", error);
    return fail("Could not securely store the credential.");
  }

  try {
    if (existing) {
      await convex.mutation(api.system.updateUserConnectionCredential, {
        internalKey, userId, connectionId: existing._id, providerId: provider.id, authMode: "oauth",
        // The token was issued for the catalog endpoint and scopes, so store those.
        serverUrl: resolveProviderMcpUrl(provider, "oauth"),
        scopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : [],
        maskedPreview: maskCredential(tokens.access_token), tokenExpiresAt: tokenExpiryFrom(tokens),
        oauthClientId: clientInformation.client_id, authServerUrl: flow.authServerUrl, ...sealed,
      });
    }
    const created = existing
      ? { projectConnectionId: undefined }
      : await convex.mutation(api.system.createUserConnection, {
      internalKey,
      userId,
      projectId: flow.projectId,
      providerId: provider.id,
      label: provider.displayName,
      authMode: "oauth",
      serverUrl: resolveProviderMcpUrl(provider, "oauth"),
      credentialRef,
      maskedPreview: maskCredential(tokens.access_token),
      scopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : [],
      tokenExpiresAt: tokenExpiryFrom(tokens),
      oauthClientId: clientInformation.client_id,
      authServerUrl: flow.authServerUrl,
      ...sealed,
    });

    return resultPage(
      "success",
      created.projectConnectionId
        ? `${provider.displayName} is connected to this project with read-only access. You can close this window.`
        : `${provider.displayName} is connected. You can close this window.`,
    );
  } catch (error) {
    console.error("[oauth/callback] failed to persist connection", error);
    return fail("Could not save the connection.");
  }
}
