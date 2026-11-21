import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { validateInternalKey } from "./internalKey";

/**
 * Storage side of the env-var KMS key move (the runner and verify pass live in
 * `src/features/integrations/server/env/rewrap-env-keys.ts`; KMS runs on the
 * Next.js host only). `internalKey` only.
 */

/**
 * One page of secret rows with their sealed payloads, in creation order. The
 * order never changes when a row's key moves, so a cursor stays valid across a
 * run. Public rows are read but not returned.
 */
export const listSecretEnvVarsPage = query({
  args: { internalKey: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    const result = await ctx.db.query("projectEnvVars").paginate(args.paginationOpts);
    return {
      isDone: result.isDone,
      continueCursor: result.continueCursor,
      page: result.page
        .filter((row) => row.visibility === "secret")
        .map((row) => ({
          _id: row._id,
          projectId: row.projectId,
          key: row.key,
          updatedAt: row.updatedAt,
          secretRef: row.secretRef,
          kekProvider: row.kekProvider,
          kekKeyId: row.kekKeyId,
          wrappedDek: row.wrappedDek,
          ciphertext: row.ciphertext,
          iv: row.iv,
          authTag: row.authTag,
        })),
    };
  },
});

const wrap = { kekProvider: v.string(), kekKeyId: v.string(), wrappedDek: v.string() };

/**
 * Compare-and-set of one row's DEK wrap. Writes only when the row, its sealed
 * revision and its project are exactly as the runner read them, so a save or
 * delete in between wins. Returns whether it wrote.
 *
 * Only the wrap fields change: the value ciphertext, updatedAt and
 * recoveryEpoch stay as they are. It does not bump envGeneration either: the
 * value is the same, so running previews are not outdated and keep running.
 */
export const rewrapEnvVarDek = mutation({
  args: {
    internalKey: v.string(),
    id: v.id("projectEnvVars"),
    expected: v.object({ ...wrap, secretRef: v.string(), updatedAt: v.number() }),
    next: v.object(wrap),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    const row = await ctx.db.get("projectEnvVars", args.id);
    const { expected } = args;
    if (
      !row ||
      row.visibility !== "secret" ||
      row.secretRef !== expected.secretRef ||
      row.kekProvider !== expected.kekProvider ||
      row.kekKeyId !== expected.kekKeyId ||
      row.wrappedDek !== expected.wrappedDek ||
      row.updatedAt !== expected.updatedAt
    ) {
      return false;
    }
    const project = await ctx.db.get("projects", row.projectId);
    if (!project || project.deletingAt !== undefined) return false;

    await ctx.db.patch("projectEnvVars", row._id, args.next);
    return true;
  },
});
