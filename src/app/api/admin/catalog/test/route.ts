import { APICallError, generateText } from "ai";
import { NextResponse } from "next/server";
import { z } from "zod";

import { ADMIN_CATALOG_TEST_RATE_LIMIT, requireAdminWrite } from "@/features/admin/server/admin-request";
import { PLATFORM_PROVIDER_IDS } from "@/features/ai-providers/platform";
import { AI_PROVIDERS, MAX_MODEL_ID_LENGTH } from "@/features/ai-providers/registry";
import { buildAiSdkModel } from "@/features/ai-providers/server/ai-sdk-model";
import { PLATFORM_KEY_ENV, platformKeyOrNull } from "@/features/ai-providers/server/platform-model";
import { parseJsonBody } from "@/lib/parse-json-body";

const requestSchema = z.object({
  provider: z.enum(PLATFORM_PROVIDER_IDS),
  providerModelId: z.string().trim().min(1).max(MAX_MODEL_ID_LENGTH),
});

const TIMEOUT_MS = 15_000;
// OpenAI's Responses API refuses fewer than 16; still a few tokens on our key.
const MAX_OUTPUT_TOKENS = 16;
const MAX_ERROR_LENGTH = 300;

// Key shapes of the four providers (sk-…, sk-ant-…, sk-or-…, gsk_…): some
// echo part of a rejected key in their error message.
const KEY_LIKE = /\b(?:sk|gsk)[-_][\w*.-]+/gi;

/** The provider's refusal, with anything key-like removed. */
function sanitizeProviderError(error: unknown, apiKey: string): string {
  if (!APICallError.isInstance(error)) {
    return error instanceof Error && error.name === "TimeoutError"
      ? `No answer within ${TIMEOUT_MS / 1000}s`
      : "The request failed before the provider answered";
  }
  const message = error.message.split(apiKey).join("[redacted]").replace(KEY_LIKE, "[redacted]");
  return `${error.statusCode ? `${error.statusCode}: ` : ""}${message}`.slice(0, MAX_ERROR_LENGTH);
}

/**
 * POST /api/admin/catalog/test: sends a tiny request through one route (a
 * provider's platform key and model) so the admin knows it runs before users
 * do. Behind the same guard as save, step-up included as ADR 0010 asks: it
 * changes nothing, but it spends on our keys, and one step-up covers ten
 * minutes of testing. Returns ok and latency, or the provider's refusal.
 */
export async function POST(request: Request) {
  const { denied } = await requireAdminWrite(request, ADMIN_CATALOG_TEST_RATE_LIMIT);
  if (denied) return denied;

  const { data, invalid } = await parseJsonBody(request, requestSchema);
  if (invalid) return invalid;

  const apiKey = platformKeyOrNull(data.provider);
  if (!apiKey) {
    console.error(`[admin-catalog] ${PLATFORM_KEY_ENV[data.provider]} is not set; can't test a ${data.provider} route.`);
    return NextResponse.json(
      { error: `${AI_PROVIDERS[data.provider].label} has no platform key`, code: "key_missing", provider: data.provider },
      { status: 409 },
    );
  }

  const startedAt = performance.now();
  try {
    await generateText({
      model: buildAiSdkModel({ provider: data.provider, apiKey, model: data.providerModelId }),
      prompt: "ping",
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: sanitizeProviderError(error, apiKey) });
  }
  return NextResponse.json({ ok: true, latencyMs: Math.round(performance.now() - startedAt) });
}
