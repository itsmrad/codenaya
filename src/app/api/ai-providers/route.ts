import { z } from "zod";

import { requireUserId } from "@/features/auth/server/require-user-id";
import {
  AI_PROVIDER_IDS,
  AI_PROVIDERS,
  MAX_CUSTOM_MODEL_IDS,
  MAX_MODEL_ID_LENGTH,
} from "@/features/ai-providers/registry";
import {
  assertSafeProviderBaseUrl,
  normalizedBaseUrl,
} from "@/features/ai-providers/server/base-url";
import { sealProviderKey } from "@/features/ai-providers/server/sealed-key";
import {
  testConnection,
  testFailureResponse,
} from "@/features/ai-providers/server/test-connection";
import {
  AI_PROVIDER_CREATE_RATE_LIMIT,
  checkRateLimit,
  rateLimitedResponse,
} from "@/features/integrations/server/rate-limit";
import { convex } from "@/lib/convex-client";

import { api } from "../../../../convex/_generated/api";

/**
 * POST /api/ai-providers
 *
 * Stores a model provider API key the user brought (BYOK). Runs here rather
 * than in Convex because it has to call the provider to test the key and seal
 * it under a KEK that deliberately does not exist in Convex's environment.
 *
 * Test first, persist second: a key that does not work is rejected on the form
 * instead of failing later inside an agent run. The response carries only the
 * masked preview, never the key.
 */

const requestSchema = z
  .object({
    provider: z.enum(AI_PROVIDER_IDS),
    apiKey: z.string().trim().min(1, "API key is required").max(1000),
    label: z.string().trim().max(80).optional(),
    /** Custom endpoints only. */
    baseUrl: z.string().trim().max(2048).optional(),
    /** Custom endpoints only. */
    modelIds: z
      .array(z.string().trim().min(1).max(MAX_MODEL_ID_LENGTH))
      .max(MAX_CUSTOM_MODEL_IDS, `At most ${MAX_CUSTOM_MODEL_IDS} model ids`)
      .optional(),
  })
  .refine(
    (body) =>
      body.provider !== "custom" || (body.baseUrl && body.modelIds?.length),
    "A custom endpoint needs a base URL and at least one model id",
  );

function jsonError(error: string, status: number, extra: Record<string, unknown> = {}) {
  return Response.json({ ok: false, error, ...extra }, { status });
}

export async function POST(request: Request) {
  const { userId, unauthorized } = await requireUserId();
  if (unauthorized) return unauthorized;

  // Each attempt makes an outbound request to the provider.
  const rateLimit = checkRateLimit(userId, AI_PROVIDER_CREATE_RATE_LIMIT);
  if (!rateLimit.allowed) return rateLimitedResponse(rateLimit);

  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
  if (!internalKey) {
    console.error("[ai-providers] CODENAYA_CONVEX_INTERNAL_KEY is not set");
    return jsonError("Server is not configured for provider keys", 500);
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

  const { provider, apiKey, label } = parsed.data;
  const isCustom = provider === "custom";

  let baseUrl: string | undefined;
  if (isCustom) {
    const verdict = await assertSafeProviderBaseUrl(parsed.data.baseUrl!);
    if (!verdict.ok) return jsonError(verdict.reason, 400, { kind: "blocked" });
    baseUrl = normalizedBaseUrl(verdict.url);
  }

  const test = await testConnection({ provider, apiKey, baseUrl });
  if (!test.ok) return testFailureResponse(test);

  let sealed;
  try {
    sealed = await sealProviderKey(apiKey);
  } catch (error) {
    // Almost always a missing or malformed CODENAYA_LOCAL_KEK.
    console.error("[ai-providers] failed to seal key", error);
    return jsonError("Could not securely store the key. Check server configuration.", 500);
  }

  try {
    const keyId = await convex.mutation(api.system.createAiProviderKey, {
      internalKey,
      userId,
      provider,
      label: label || AI_PROVIDERS[provider].label,
      baseUrl,
      modelIds: isCustom ? [...new Set(parsed.data.modelIds)] : undefined,
      ...sealed,
    });

    return Response.json({
      ok: true,
      keyId,
      maskedPreview: sealed.maskedPreview,
      status: "active",
    });
  } catch (error) {
    console.error("[ai-providers] failed to persist key", error);
    return jsonError("Could not save the key", 500);
  }
}
