import { requireUserId } from "@/features/auth/server/require-user-id";
import { openProviderKey } from "@/features/ai-providers/server/sealed-key";
import {
  testConnection,
  testFailureResponse,
} from "@/features/ai-providers/server/test-connection";
import {
  AI_PROVIDER_TEST_RATE_LIMIT,
  checkRateLimit,
  rateLimitedResponse,
} from "@/features/integrations/server/rate-limit";
import { convex } from "@/lib/convex-client";

import { api } from "../../../../../../convex/_generated/api";
import { Id } from "../../../../../../convex/_generated/dataModel";

/**
 * POST /api/ai-providers/:id/test
 *
 * Re-tests a stored key and records the outcome on the row, so a key revoked
 * at the provider shows up as `invalid` in settings. The key is opened only in
 * this process and never returned.
 */

interface RouteParams {
  params: Promise<{ id: string }>;
}

function jsonError(error: string, status: number) {
  return Response.json({ ok: false, error }, { status });
}

export async function POST(_request: Request, { params }: RouteParams) {
  const { userId, unauthorized } = await requireUserId();
  if (unauthorized) return unauthorized;

  const rateLimit = checkRateLimit(userId, AI_PROVIDER_TEST_RATE_LIMIT);
  if (!rateLimit.allowed) return rateLimitedResponse(rateLimit);

  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
  if (!internalKey) {
    console.error("[ai-providers/test] CODENAYA_CONVEX_INTERNAL_KEY is not set");
    return jsonError("Server is not configured for provider keys", 500);
  }

  const keyId = (await params).id as Id<"aiProviderKeys">;

  let key;
  try {
    key = await convex.query(api.system.getAiProviderKeyForUser, {
      internalKey,
      keyId,
      userId,
    });
  } catch {
    // A malformed id fails Convex argument validation.
    key = null;
  }
  if (!key) return jsonError("Key not found", 404);

  let apiKey: string;
  try {
    apiKey = await openProviderKey(key);
  } catch (error) {
    console.error("[ai-providers/test] failed to open key", error);
    return jsonError("Could not read the stored key. Check server configuration.", 500);
  }

  const test = await testConnection({
    provider: key.provider,
    apiKey,
    baseUrl: key.baseUrl,
  });

  // Only a definite answer from the provider changes the stored status; a
  // timeout says nothing about the key itself.
  if (test.ok || test.kind === "unauthorized") {
    try {
      await convex.mutation(api.system.updateAiProviderKeyStatus, {
        internalKey,
        keyId,
        userId,
        status: test.ok ? "active" : "invalid",
        statusMessage: test.ok ? undefined : test.error,
      });
    } catch (error) {
      console.error("[ai-providers/test] failed to update status", error);
      return jsonError("Could not save the test result", 500);
    }
  }

  return test.ok
    ? Response.json({ ok: true, status: "active" })
    : testFailureResponse(test);
}
