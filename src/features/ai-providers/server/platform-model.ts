import { convex } from "@/lib/convex-client";

import {
  type PlatformProviderId,
  type RoutedCatalog,
  type RoutedModel,
  envCatalog,
  platformProviderId,
} from "../platform";
import { buildAgentKitModel } from "./agentkit-model";
import { buildAiSdkModel } from "./ai-sdk-model";
import { api } from "../../../../convex/_generated/api";

/**
 * Codenaya's own models, each on its catalog route's provider (ADR 0010): the
 * admin's catalog in /admin, else `NEXT_PUBLIC_AI_PROVIDER`'s curated one
 * (ADR 0005). Every run takes its provider from the route it resolved, never
 * the env alone. Server only: this is the one place that reads the platform keys.
 * They never reach the client, Convex, a step result or a log.
 *
 * Keys are read at call time, not module load, so importing this file never
 * fails when one is absent (that would break `next build`).
 */

/** The env var holding each provider's platform key. */
export const PLATFORM_KEY_ENV: Record<PlatformProviderId, string> = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  groq: "GROQ_API_KEY",
};

/** Sent to the user when the platform has no key. The env var name is logged, not sent. */
export const AI_NOT_CONFIGURED_MESSAGE =
  "Codenaya AI isn't available right now. Try again later, or add your own key in Settings → AI providers.";

/** The provider's platform key, or null when its variable isn't set. Quiet. */
export const platformKeyOrNull = (provider: PlatformProviderId) =>
  process.env[PLATFORM_KEY_ENV[provider]]?.trim() || null;

/**
 * The catalog platform requests are routed with: the admin's, else the env
 * provider's curated one. One Convex read.
 */
export async function platformCatalog(internalKey: string): Promise<RoutedCatalog> {
  const saved = await convex.query(api.platformCatalog.getForServer, { internalKey });
  return saved ?? envCatalog(platformProviderId());
}

/** True when the provider has a key. Lets callers refuse cleanly rather than throw. */
export function isPlatformConfigured(provider: PlatformProviderId): boolean {
  if (platformKeyOrNull(provider)) return true;
  console.error(
    `[ai-provider] ${PLATFORM_KEY_ENV[provider]} is not set, so platform AI on ${provider} is unavailable.`,
  );
  return false;
}

/** The provider's key. Throws, naming the variable to set. */
export function readPlatformApiKey(provider: PlatformProviderId): string {
  const apiKey = platformKeyOrNull(provider);
  if (!apiKey) {
    throw new Error(
      `${PLATFORM_KEY_ENV[provider]} is not configured. Add it to .env.local and ` +
        "to the deployment environment.",
    );
  }
  return apiKey;
}

/**
 * AgentKit model for an agent run, on a route's provider and its model id.
 *
 * @param temperature Omitted for models that reject it — some reasoning models
 * error on a non-default temperature rather than ignoring it.
 */
export function platformAgentModel(
  provider: PlatformProviderId,
  providerModelId: string,
  temperature?: number,
) {
  return buildAgentKitModel({
    provider,
    apiKey: readPlatformApiKey(provider),
    model: providerModelId,
    temperature,
  });
}

/**
 * AI SDK model for the editor AI routes. Editor tasks are short and
 * latency-sensitive, so they run on the catalog's utility model (`utilityModel`).
 */
export function platformEditorModel({ provider, providerModelId }: Pick<RoutedModel, "provider" | "providerModelId">) {
  return buildAiSdkModel({
    provider,
    apiKey: readPlatformApiKey(provider),
    model: providerModelId,
  });
}
