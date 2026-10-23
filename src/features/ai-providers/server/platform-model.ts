import { wrapLanguageModel } from "ai";
import { after } from "next/server";

import { type UsageStatus, monthKey } from "@/features/ai-usage/limits";
import { convex } from "@/lib/convex-client";

import { AI_PROVIDERS } from "../registry";
import {
  type ActivePlatform,
  type PlatformProviderId,
  platformConfigFrom,
  platformProviderId,
} from "../platform";
import { buildAgentKitModel } from "./agentkit-model";
import { buildAiSdkModel } from "./ai-sdk-model";
import { api } from "../../../../convex/_generated/api";

/**
 * Codenaya's own models, on the active platform provider: the admin's choice
 * in /admin, else `NEXT_PUBLIC_AI_PROVIDER` (ADR 0005, ADR 0006). Every
 * function takes the provider from `activePlatform`, never the env alone, so a
 * switch in /admin applies everywhere. Server only: this is the one place that reads the platform keys.
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
 * The provider and model selection platform requests run on: the admin's in
 * /admin, else the env provider and its catalog. One Convex read, which with
 * `usageOf` also carries that user's usage this month against their caps.
 */
export async function activePlatform(
  internalKey: string,
  usageOf?: { userId: string },
): Promise<ActivePlatform & { usage?: UsageStatus }> {
  const { provider, config, usage } = await convex.query(api.platformModels.getActiveForServer, {
    internalKey,
    fallbackProvider: platformProviderId(),
    ...(usageOf ? { usageOf: { userId: usageOf.userId, month: monthKey() } } : {}),
  });
  return { provider, config: platformConfigFrom(config), ...(usage ? { usage } : {}) };
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
 * AgentKit model for an agent run.
 *
 * @param temperature Omitted for models that reject it — some reasoning models
 * error on a non-default temperature rather than ignoring it.
 */
export function platformAgentModel(
  provider: PlatformProviderId,
  model: string,
  temperature?: number,
) {
  return buildAgentKitModel({
    provider,
    apiKey: readPlatformApiKey(provider),
    model,
    temperature,
  });
}

/** The provider's small model, for titles and editor AI. */
export const platformTitleModel = (provider: PlatformProviderId) =>
  AI_PROVIDERS[provider].titleModel!;

/**
 * AI SDK model for the editor AI routes. Editor tasks are short and
 * latency-sensitive, so they run on the provider's small model. Each call is
 * metered to `userId` after the response is sent (`after`), so the answer
 * doesn't wait on the write; a failed record is logged, not thrown.
 */
export function platformEditorModel(
  provider: PlatformProviderId,
  { internalKey, userId }: { internalKey: string; userId: string },
) {
  const modelId = platformTitleModel(provider);
  return wrapLanguageModel({
    model: buildAiSdkModel({ provider, apiKey: readPlatformApiKey(provider), model: modelId }),
    middleware: {
      specificationVersion: "v3",
      wrapGenerate: async ({ doGenerate }) => {
        const result = await doGenerate();
        after(() =>
          convex.mutation(api.aiUsage.record, {
            internalKey,
            key: `editor:${crypto.randomUUID()}`,
            userId,
            source: "editor",
            provider,
            modelId,
            inputTokens: result.usage.inputTokens.total ?? 0,
            outputTokens: result.usage.outputTokens.total ?? 0,
          }).catch((error) => console.error("[ai-usage] failed to record editor usage", error)),
        );
        return result;
      },
    },
  });
}
