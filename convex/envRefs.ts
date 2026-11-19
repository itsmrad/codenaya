import { v } from "convex/values";

import { mutation } from "./_generated/server";
import { appError } from "./errors";
import { validateInternalKey } from "./internalKey";
import { getOwnedProject } from "./projects";

/**
 * Env refs: sealed values redacted from MCP tool results, which the agent can
 * store as env vars by ref without ever seeing them
 * (`features/integrations/server/mcp/env-refs.ts`).
 *
 * Internal-key only. Nothing here returns a value: Convex holds ciphertext, and
 * only the Next.js/Inngest side has the KEK to open it.
 */

/** One agent run fits well inside this; the approvals cron deletes them after. */
const ENV_REF_TTL_MS = 60 * 60 * 1000;

/** Most refs one tool result may mint; more and the caller falls back to placeholders. */
const MAX_REFS_PER_RESULT = 100;

const visibilityValidator = v.union(v.literal("public"), v.literal("secret"));

const sealedValidators = {
  kekProvider: v.string(),
  kekKeyId: v.string(),
  wrappedDek: v.string(),
  ciphertext: v.string(),
  iv: v.string(),
  authTag: v.string(),
};

export const createEnvRefs = mutation({
  args: {
    internalKey: v.string(),
    projectId: v.id("projects"),
    ownerId: v.string(),
    messageId: v.id("messages"),
    providerId: v.string(),
    toolName: v.string(),
    refs: v.array(
      v.object({
        refId: v.string(),
        visibility: visibilityValidator,
        rule: v.string(),
        ...sealedValidators,
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    await getOwnedProject(ctx, args.projectId, args.ownerId);
    if (args.refs.length > MAX_REFS_PER_RESULT) {
      throw appError("LIMIT_EXCEEDED", "Too many values to reference in one result");
    }

    const expiresAt = Date.now() + ENV_REF_TTL_MS;
    for (const ref of args.refs) {
      await ctx.db.insert("mcpEnvRefs", {
        ...ref,
        projectId: args.projectId,
        ownerId: args.ownerId,
        messageId: args.messageId,
        providerId: args.providerId,
        toolName: args.toolName,
        expiresAt,
      });
    }
    return null;
  },
});

/**
 * The sealed ref for this exact project, owner and run, or `null` when it is
 * unknown, expired or bound elsewhere (indistinguishable on purpose). Also says
 * whether `key` is already set, for the overwrite guard.
 *
 * A mutation only because it reads the clock, which a query must not.
 */
export const resolveEnvRef = mutation({
  args: {
    internalKey: v.string(),
    refId: v.string(),
    projectId: v.id("projects"),
    ownerId: v.string(),
    messageId: v.id("messages"),
    key: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({ visibility: visibilityValidator, keyExists: v.boolean(), ...sealedValidators }),
  ),
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);

    const ref = await ctx.db
      .query("mcpEnvRefs")
      .withIndex("by_refId", (q) => q.eq("refId", args.refId))
      .unique();
    if (
      !ref ||
      ref.projectId !== args.projectId ||
      ref.ownerId !== args.ownerId ||
      ref.messageId !== args.messageId ||
      ref.expiresAt <= Date.now()
    ) {
      return null;
    }

    const existing = await ctx.db
      .query("projectEnvVars")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("key", args.key),
      )
      .first();

    return {
      visibility: ref.visibility,
      keyExists: existing !== null,
      kekProvider: ref.kekProvider,
      kekKeyId: ref.kekKeyId,
      wrappedDek: ref.wrappedDek,
      ciphertext: ref.ciphertext,
      iv: ref.iv,
      authTag: ref.authTag,
    };
  },
});
