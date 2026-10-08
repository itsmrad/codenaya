import { requireUserId } from "@/features/auth/server/require-user-id";
import { nanoid } from "nanoid";
import { z } from "zod";

import {
  classifyEnvKey,
  isValidEnvKey,
  maskSecret,
} from "@/features/integrations/env-keys";
import {
  getSecretSealer,
  secretContext,
} from "@/features/integrations/server/crypto";
import {
  ENV_VAR_RATE_LIMIT,
  checkRateLimit,
  rateLimitedResponse,
} from "@/features/integrations/server/rate-limit";
import { requireOwnedProject } from "@/features/projects/server/require-owned-project";
import { convex } from "@/lib/convex-client";

import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";

/**
 * POST /api/env-vars
 *
 * Stores a **secret** project environment variable entered in the IDE.
 *
 * Public variables do not come here: the browser writes them directly through
 * `envVars.setPublicEnvVar`. A secret has to be sealed with `node:crypto` under a
 * KEK that deliberately does not exist in Convex's environment, so this route
 * seals it and hands only ciphertext to Convex — the same path the agent's
 * `setEnvVar` tool uses.
 */

const requestSchema = z.object({
  projectId: z.string().min(1),
  key: z.string().trim().min(1, "Key is required"),
  value: z.string().min(1, "Value is required"),
});

function jsonError(error: string, status: number) {
  return Response.json({ ok: false, error }, { status });
}

export async function POST(request: Request) {
  const { userId, unauthorized } = await requireUserId();

  if (unauthorized) {
    return unauthorized;
  }

  const rateLimit = checkRateLimit(userId, ENV_VAR_RATE_LIMIT);
  if (!rateLimit.allowed) {
    return rateLimitedResponse(rateLimit);
  }

  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
  if (!internalKey) {
    console.error("[env-vars] CODENAYA_CONVEX_INTERNAL_KEY is not set");
    return jsonError("Server is not configured for secrets", 500);
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

  const { key, value } = parsed.data;
  const projectId = parsed.data.projectId as Id<"projects">;

  if (!isValidEnvKey(key)) {
    return jsonError(
      `"${key}" is not a valid environment variable name. Use letters, digits ` +
        `and underscores, starting with a letter or underscore.`,
      400,
    );
  }

  // A public-prefixed key ends up in the client bundle regardless, so sealing it
  // would be a false promise. The client stores those via the public mutation.
  if (classifyEnvKey(key) === "public") {
    return jsonError(`"${key}" is a public variable and cannot be stored as a secret`, 400);
  }

  const { notFound } = await requireOwnedProject({ internalKey, userId, projectId });
  if (notFound) return notFound;

  // Generated before the insert so it can anchor the AAD in a single write.
  const secretRef = nanoid();

  let sealed;
  try {
    sealed = await getSecretSealer().seal(
      value,
      secretContext("projectEnvVars", secretRef, "value"),
    );
  } catch (error) {
    console.error("[env-vars] failed to seal secret", error);
    return jsonError(
      "Could not securely store the secret. Check server configuration.",
      500,
    );
  }

  try {
    await convex.mutation(api.system.setSecretEnvVar, {
      internalKey,
      projectId,
      ownerId: userId,
      key,
      secretRef,
      maskedPreview: maskSecret(value),
      source: "manual",
      ...sealed,
    });
    return Response.json({ ok: true });
  } catch (error) {
    console.error("[env-vars] failed to persist secret", error);
    return jsonError("Could not save the secret", 500);
  }
}
