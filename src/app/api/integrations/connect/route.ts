import { auth } from "@clerk/nextjs/server";
import { nanoid } from "nanoid";
import { z } from "zod";

import { getProvider } from "@/features/integrations/catalog";
import { maskCredential } from "@/features/integrations/env-keys";
import {
  getSecretSealer,
  secretContext,
} from "@/features/integrations/server/crypto";
import { probeMcpServer } from "@/features/integrations/server/mcp/probe";
import { assertSafeMcpUrl } from "@/features/integrations/server/url-guard";
import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";

/**
 * POST /api/integrations/connect
 *
 * Creates an API-key MCP connection for the signed-in user.
 *
 * ## Why this is a route handler rather than a Convex mutation
 *
 * Two things have to happen here that Convex's runtime cannot do: opening an
 * outbound MCP connection to validate the key, and sealing it with `node:crypto`
 * under a KEK that deliberately does not exist in Convex's environment. So the
 * route validates and seals, then hands only ciphertext to Convex.
 *
 * ## Order of operations
 *
 * Probe first, persist second. Storing an unusable credential would leave the
 * user with a connection that looks fine and fails later inside an agent run,
 * which is much harder to diagnose than an error on the form they just submitted.
 */

const requestSchema = z.object({
  providerId: z.string().min(1),
  apiKey: z.string().min(1, "API key is required"),
  label: z.string().max(80).optional(),
  /** Required when providerId is "custom". */
  serverUrl: z.string().url().optional(),
});

const CUSTOM_PROVIDER_ID = "custom";

/** Fallback placement for custom servers, which is what most MCP servers expect. */
const DEFAULT_API_KEY_PLACEMENT = {
  header: "Authorization",
  valuePrefix: "Bearer ",
} as const;

function jsonError(
  error: string,
  status: number,
  extra: Record<string, unknown> = {},
) {
  return Response.json({ ok: false, error, ...extra }, { status });
}

export async function POST(request: Request) {
  const { userId } = await auth();

  if (!userId) {
    return jsonError("Unauthorized", 401);
  }

  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
  if (!internalKey) {
    console.error("[integrations/connect] CODENAYA_CONVEX_INTERNAL_KEY is not set");
    return jsonError("Server is not configured for integrations", 500);
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

  const { providerId, apiKey, label, serverUrl } = parsed.data;

  // ── Resolve the target endpoint and credential placement ──

  let mcpUrl: string;
  let placement: { header: string; valuePrefix: string };
  let displayName: string;
  let trustedHosts: readonly string[] | undefined;

  if (providerId === CUSTOM_PROVIDER_ID) {
    if (!serverUrl) {
      return jsonError("A server URL is required for a custom MCP server", 400);
    }

    // Custom URLs are user-supplied, so they get full DNS validation with no
    // trusted-host bypass. Checked here as well as inside the probe so an
    // invalid URL is rejected with a precise message.
    const verdict = await assertSafeMcpUrl(serverUrl);
    if (!verdict.ok) {
      return jsonError(verdict.reason, 400, { kind: "blocked" });
    }

    mcpUrl = verdict.url.toString();
    placement = DEFAULT_API_KEY_PLACEMENT;
    displayName = "Custom MCP server";
  } else {
    const provider = getProvider(providerId);

    if (!provider) {
      return jsonError(`Unknown provider "${providerId}"`, 400);
    }

    if (!provider.authModes.includes("api_key")) {
      // Surfaced explicitly because the alternative — silently attempting an
      // API-key connection against an OAuth-only server — produces a confusing
      // 401 rather than an actionable message.
      return jsonError(
        `${provider.displayName} does not support API key authentication. Connect it with OAuth instead.`,
        400,
      );
    }

    mcpUrl = provider.mcpUrl;
    placement = provider.apiKey ?? DEFAULT_API_KEY_PLACEMENT;
    displayName = provider.displayName;
    trustedHosts = provider.trustedHostnames;
  }

  // ── Probe before persisting ──

  const trimmedKey = apiKey.trim();

  const probe = await probeMcpServer({
    url: mcpUrl,
    // Undefined for custom servers, so a user-supplied URL gets full DNS
    // validation rather than inheriting the catalog's allowlist.
    trustedHosts,
    headers: {
      [placement.header]: `${placement.valuePrefix}${trimmedKey}`,
    },
  });

  if (!probe.ok) {
    return jsonError(probe.error, probe.kind === "unauthorized" ? 400 : 502, {
      kind: probe.kind,
    });
  }

  // ── Seal and persist ──

  // Generated before the insert so it can anchor the AAD in a single write; the
  // Convex `_id` is not known until afterwards. Immutable for the row's lifetime.
  const credentialRef = nanoid();

  let sealed;
  try {
    sealed = await getSecretSealer().seal(
      // Stored as JSON so an OAuth refresh can later add fields without a schema
      // migration or a second envelope.
      JSON.stringify({ type: "api_key", apiKey: trimmedKey }),
      secretContext("userConnections", credentialRef, "credential"),
    );
  } catch (error) {
    // Almost always a missing or malformed CODENAYA_LOCAL_KEK. Logged server-side
    // with detail; the client gets a generic message since the detail names
    // internal configuration.
    console.error("[integrations/connect] failed to seal credential", error);
    return jsonError(
      "Could not securely store the credential. Check server configuration.",
      500,
    );
  }

  try {
    const connectionId = await convex.mutation(api.system.createUserConnection, {
      internalKey,
      userId,
      providerId,
      label: label?.trim() || displayName,
      authMode: "api_key",
      serverUrl: mcpUrl,
      credentialRef,
      maskedPreview: maskCredential(trimmedKey),
      // API keys carry no OAuth scopes; the array stays empty so the UI can rely
      // on a consistent shape across both auth modes.
      scopes: [],
      ...sealed,
    });

    return Response.json({
      ok: true,
      connectionId,
      provider: { id: providerId, displayName },
      toolCount: probe.tools.length,
      truncated: probe.truncated,
      tools: probe.tools,
      serverName: probe.serverName,
    });
  } catch (error) {
    console.error("[integrations/connect] failed to persist connection", error);
    return jsonError("Could not save the connection", 500);
  }
}

// Note: no `export const runtime` here. Node is already the default for route
// handlers, and declaring it explicitly is rejected when `cacheComponents` is
// enabled in next.config.ts — which it is for this project.
