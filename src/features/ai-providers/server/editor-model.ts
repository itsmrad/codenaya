import type { LanguageModel } from "ai";
import { NextResponse } from "next/server";

import { USAGE_LIMIT_CODE, monthKey, usageLimitMessage } from "@/features/ai-usage/limits";
import { convex } from "@/lib/convex-client";
import { AI_PROVIDERS, PROVIDER_KEY_ERROR_CODE, modelIdsFor } from "../registry";
import { buildAiSdkModel } from "./ai-sdk-model";
import {
  AI_NOT_CONFIGURED_MESSAGE,
  activePlatform,
  isPlatformConfigured,
  platformEditorModel,
} from "./platform-model";
import { ProviderKeyError, isProviderKeyRejection } from "./resolve-run-model";
import { openProviderKey } from "./sealed-key";
import { api } from "../../../../convex/_generated/api";
import type { Doc } from "../../../../convex/_generated/dataModel";

/**
 * The model for the editor AI routes (`/api/suggestion`, `/api/quick-edit`,
 * `/api/enhance-prompt`):
 * the user's default key when they set one, otherwise Codenaya's platform
 * model. Resolved per request on the server; the decrypted key never leaves it.
 *
 * As with agent runs, a key that cannot be used is an error, never a silent
 * switch to the platform key.
 */

const settingsHint = "Update it in Settings → AI providers.";

export interface EditorModel {
  model: LanguageModel;
  /** Set when the model runs on the user's own key. Holds no key material. */
  key?: Pick<Doc<"aiProviderKeys">, "_id" | "userId" | "label">;
}

/**
 * Editor tasks are short and latency-sensitive, so a key runs them on its
 * provider's small model, as the platform does. Custom endpoints have no
 * curated small model and use the user's default.
 */
const editorModelIdFor = (provider: Doc<"aiProviderKeys">["provider"], defaultModelId: string) =>
  AI_PROVIDERS[provider].titleModel ?? defaultModelId;

/** Platform editor AI refused: the user is over their monthly cap. */
export class UsageLimitError extends Error {}

/**
 * Returns null when the user has no default key and the platform is not
 * configured. Throws `UsageLimitError` when platform AI is over the user's
 * monthly cap, and `ProviderKeyError` when the default key is gone, marked
 * invalid, or no longer offers the model.
 */
export async function resolveEditorModel({
  internalKey,
  userId,
}: {
  internalKey: string;
  userId: string;
}): Promise<EditorModel | null> {
  // In parallel, so a platform request pays no extra round trip; the usage
  // check rides on the platform read.
  const [byok, platform] = await Promise.all([
    convex.query(api.system.getDefaultAiProviderKey, { internalKey, userId }),
    activePlatform(internalKey, { userId }),
  ]);

  if (!byok) {
    if (!isPlatformConfigured(platform.provider)) return null;
    if (platform.usage?.exceeded) {
      throw new UsageLimitError(usageLimitMessage(platform.usage, monthKey()));
    }
    return { model: platformEditorModel(platform.provider, { internalKey, userId }) };
  }

  const { key, modelId } = byok;
  if (!key) {
    throw new ProviderKeyError(`Your default AI provider key no longer exists. ${settingsHint}`);
  }
  if (key.status === "invalid") {
    throw new ProviderKeyError(`Your ${key.label} key was rejected by the provider. ${settingsHint}`);
  }
  if (!modelIdsFor(key).includes(modelId)) {
    throw new ProviderKeyError(`Your ${key.label} key no longer offers ${modelId}. ${settingsHint}`);
  }

  const apiKey = await openProviderKey(key);
  return {
    model: buildAiSdkModel({
      provider: key.provider,
      apiKey,
      baseUrl: key.baseUrl,
      model: editorModelIdFor(key.provider, modelId),
    }),
    key: { _id: key._id, userId: key.userId, label: key.label },
  };
}

const notConfigured = () =>
  NextResponse.json({ error: AI_NOT_CONFIGURED_MESSAGE, code: "ai_not_configured" }, { status: 503 });

const keyErrorResponse = (message: string) =>
  NextResponse.json({ error: message, code: PROVIDER_KEY_ERROR_CODE }, { status: 422 });

/**
 * Runs an editor AI request on the resolved model. Over the monthly cap is a
 * 402 with `code: "usage_limit"`. Key problems come back as a
 * 422 with `code: PROVIDER_KEY_ERROR_CODE`; a provider refusing the key also
 * marks it invalid, as an agent run does. Other errors propagate.
 */
export async function withEditorModel(
  { userId }: { userId: string },
  generate: (model: LanguageModel) => Promise<Response>,
): Promise<Response> {
  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
  if (!internalKey) {
    return notConfigured();
  }

  let resolved: EditorModel | null;
  try {
    resolved = await resolveEditorModel({ internalKey, userId });
  } catch (error) {
    if (error instanceof ProviderKeyError) {
      return keyErrorResponse(error.message);
    }
    if (error instanceof UsageLimitError) {
      return NextResponse.json({ error: error.message, code: USAGE_LIMIT_CODE }, { status: 402 });
    }
    throw error;
  }

  if (!resolved) {
    return notConfigured();
  }

  const { model, key } = resolved;
  try {
    return await generate(model);
  } catch (error) {
    if (!key || !isProviderKeyRejection(error)) {
      throw error;
    }
    await convex.mutation(api.system.updateAiProviderKeyStatus, {
      internalKey,
      keyId: key._id,
      userId: key.userId,
      status: "invalid",
      statusMessage: "The provider rejected this key during an editor AI request.",
    });
    return keyErrorResponse(`Your ${key.label} key was rejected by the provider. ${settingsHint}`);
  }
}
