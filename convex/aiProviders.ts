import { v } from "convex/values";

import {
  isAgentModelId,
  DEFAULT_AGENT_MODEL_ID,
} from "../src/features/conversations/agent-models";
import { modelIdsFor } from "../src/features/ai-providers/registry";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx, mutation, query } from "./_generated/server";
import { verifyAuth } from "./auth";

/**
 * User-facing BYOK functions. Keys are created and tested by the Next.js
 * routes under `/api/ai-providers`, which hold the KEK; nothing here writes or
 * returns key material, and there is deliberately no way to reveal a key.
 */

/** Bound on keys returned; far above what anyone needs. */
const MAX_KEYS_LISTED = 100;

/** Key fields that are safe to send to the browser. */
export interface AiProviderKeySummary {
  _id: Id<"aiProviderKeys">;
  provider: Doc<"aiProviderKeys">["provider"];
  label: string;
  baseUrl?: string;
  modelIds?: string[];
  maskedPreview: string;
  status: Doc<"aiProviderKeys">["status"];
  lastTestedAt?: number;
}

/**
 * Explicit allowlist rather than stripping sealed fields, so a field added to
 * the schema later cannot leak to the client by default.
 */
export function toKeySummary(doc: Doc<"aiProviderKeys">): AiProviderKeySummary {
  return {
    _id: doc._id,
    provider: doc.provider,
    label: doc.label,
    baseUrl: doc.baseUrl,
    modelIds: doc.modelIds,
    maskedPreview: doc.maskedPreview,
    status: doc.status,
    lastTestedAt: doc.lastTestedAt,
  };
}

async function assertKeyOwner(
  ctx: QueryCtx | MutationCtx,
  keyId: Id<"aiProviderKeys">,
  userId: string,
): Promise<Doc<"aiProviderKeys">> {
  const key = await ctx.db.get("aiProviderKeys", keyId);
  if (!key || key.userId !== userId) {
    throw new Error("AI provider key not found");
  }
  return key;
}

const getPreferencesRow = (ctx: QueryCtx, userId: string) =>
  ctx.db
    .query("userAiPreferences")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();

/** The signed-in user's keys, newest first. */
export const list = query({
  args: {},
  handler: async (ctx): Promise<AiProviderKeySummary[]> => {
    const identity = await verifyAuth(ctx);

    const keys = await ctx.db
      .query("aiProviderKeys")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .order("desc")
      .take(MAX_KEYS_LISTED);

    return keys.map(toKeySummary);
  },
});

/** Deletes a key. A default that pointed at it falls back to the platform. */
export const remove = mutation({
  args: { keyId: v.id("aiProviderKeys") },
  handler: async (ctx, { keyId }) => {
    const identity = await verifyAuth(ctx);
    await assertKeyOwner(ctx, keyId, identity.subject);

    await ctx.db.delete("aiProviderKeys", keyId);

    const preferences = await getPreferencesRow(ctx, identity.subject);
    if (preferences?.defaultKeyId === keyId) {
      await ctx.db.patch("userAiPreferences", preferences._id, {
        defaultKeyId: undefined,
        defaultModelId: DEFAULT_AGENT_MODEL_ID,
        updatedAt: Date.now(),
      });
    }
  },
});

/** The default model. No `defaultKeyId` means the Codenaya platform key. */
export const getPreferences = query({
  args: {},
  handler: async (ctx) => {
    const identity = await verifyAuth(ctx);

    const preferences = await getPreferencesRow(ctx, identity.subject);
    return {
      defaultKeyId: preferences?.defaultKeyId ?? null,
      defaultModelId: preferences?.defaultModelId ?? DEFAULT_AGENT_MODEL_ID,
    };
  },
});

/**
 * Sets the default model, on one of the user's keys or (without a key) on the
 * platform. The model must be one the chosen provider offers.
 */
export const setPreferences = mutation({
  args: {
    defaultKeyId: v.optional(v.id("aiProviderKeys")),
    defaultModelId: v.string(),
  },
  handler: async (ctx, { defaultKeyId, defaultModelId }) => {
    const identity = await verifyAuth(ctx);

    const allowed = defaultKeyId
      ? modelIdsFor(await assertKeyOwner(ctx, defaultKeyId, identity.subject)).includes(
          defaultModelId,
        )
      : isAgentModelId(defaultModelId);
    if (!allowed) {
      throw new Error("Model is not available for this provider");
    }

    const preferences = await getPreferencesRow(ctx, identity.subject);
    const fields = { defaultKeyId, defaultModelId, updatedAt: Date.now() };

    if (preferences) {
      await ctx.db.patch("userAiPreferences", preferences._id, fields);
    } else {
      await ctx.db.insert("userAiPreferences", {
        userId: identity.subject,
        ...fields,
      });
    }
  },
});
