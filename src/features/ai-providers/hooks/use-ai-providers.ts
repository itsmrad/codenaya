import ky, { HTTPError } from "ky";
import { useMutation, useQuery } from "convex/react";

import type { AiProviderId } from "../registry";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";

/**
 * Bindings for the AI providers settings tab. Keys are listed and deleted in
 * Convex, but created and tested through `/api/ai-providers`, which holds the
 * KEK and talks to the provider. Nothing here ever receives key material.
 */

/** The signed-in user's keys, newest first, as browser-safe summaries. */
export const useAiProviderKeys = () => useQuery(api.aiProviders.list);

export const useRemoveAiProviderKey = () => useMutation(api.aiProviders.remove);

/** The default model; no `defaultKeyId` means the Codenaya platform key. */
export const useAiPreferences = () => useQuery(api.aiProviders.getPreferences);

export const useSetAiPreferences = () =>
  useMutation(api.aiProviders.setPreferences);

export interface AddAiProviderKeyInput {
  provider: AiProviderId;
  apiKey: string;
  label?: string;
  baseUrl?: string;
  modelIds?: string[];
}

/** Tests the key with the provider, then stores it sealed. */
export const addAiProviderKey = (input: AddAiProviderKeyInput) =>
  ky.post("/api/ai-providers", { json: input, timeout: 30_000 }).json();

/** Re-tests a stored key; the route records the outcome on the key. */
export const testAiProviderKey = (keyId: Id<"aiProviderKeys">) =>
  ky.post(`/api/ai-providers/${keyId}/test`, { timeout: 30_000 }).json();

const FALLBACK_MESSAGE = "Something went wrong. Please try again.";

/**
 * The message to show for a failed `/api/ai-providers` call. The routes write
 * errors for users (rejected key, unsafe URL, rate limit) and never echo the
 * key, so their text is shown as is.
 */
export const aiProviderRequestError = async (error: unknown) => {
  if (error instanceof HTTPError) {
    const body = await error.response
      .json<{ error?: string }>()
      .catch(() => ({ error: undefined }));
    return body.error ?? FALLBACK_MESSAGE;
  }
  return FALLBACK_MESSAGE;
};
