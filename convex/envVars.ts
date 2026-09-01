import { v } from "convex/values";

import {
  PUBLIC_KEY_PREFIXES,
  assertValidEnvKey,
  isPublicByConvention,
} from "../src/features/integrations/env-keys";
import { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { verifyAuth } from "./auth";
import { assertProjectOwner } from "./integrations";

/**
 * Project environment variables.
 *
 * ## The security boundary this file exists to enforce
 *
 * There are two preview backends and they are not equally trustworthy:
 *
 *  - **E2B** runs server-side. `sandbox.files.write` never touches the browser,
 *    so secrets are safe there.
 *  - **WebContainer** boots *in the page* (`WC.boot()` in
 *    `use-webcontainer.ts`) and is fed files fetched by the client. Anything
 *    mounted there is readable by the end user via devtools, and by anyone they
 *    share a preview with.
 *
 * So `visibility` is a real boundary, not a label. It is enforced by having two
 * separate functions with different capabilities rather than one function with a
 * flag:
 *
 *  - `listEnvVars` / `listPublicEnvVars` — client-callable. **Structurally
 *    incapable** of returning a secret value: they never read the sealed fields.
 *  - `system.getEnvVarsForSandbox` — `internalKey` only, server-side, returns
 *    sealed values for the E2B route to decrypt.
 *
 * A single function taking `includeSecrets: boolean` would put one mistaken
 * caller between a service-role key and the browser. Two functions cannot be
 * misused that way.
 */

/**
 * Preview shown in the UI for a secret value.
 *
 * Short values reveal nothing at all: a 6-character token would otherwise be
 * mostly displayed. Longer values show only a trailing fragment, which is enough
 * to tell two keys apart without being enough to use one.
 */
export function maskSecret(value: string): string {
  if (value.length <= 8) return "••••••••";
  return `••••${value.slice(-4)}`;
}

/** Browser-safe view of one variable. */
export interface EnvVarSummary {
  _id: Doc<"projectEnvVars">["_id"];
  key: string;
  visibility: "public" | "secret";
  /** Present only for public variables; secrets expose `maskedPreview` instead. */
  value?: string;
  maskedPreview: string;
  source: "manual" | "integration";
  updatedAt: number;
}

/**
 * Field allowlist. Sealed fields are never read here, so this cannot leak them
 * even if the schema gains more of them later.
 */
function toEnvVarSummary(doc: Doc<"projectEnvVars">): EnvVarSummary {
  return {
    _id: doc._id,
    key: doc.key,
    visibility: doc.visibility,
    value: doc.visibility === "public" ? doc.plainValue : undefined,
    maskedPreview: doc.maskedPreview,
    source: doc.source,
    updatedAt: doc.updatedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All variables for a project, for the settings editor.
 *
 * Secret values are represented by `maskedPreview` only. There is deliberately
 * no "reveal" query: once a secret is stored, the platform has no reason to hand
 * it back to a browser, and not having the endpoint means it cannot be abused.
 */
export const listEnvVars = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<EnvVarSummary[]> => {
    const identity = await verifyAuth(ctx);
    await assertProjectOwner(ctx, args.projectId, identity.subject);

    const vars = await ctx.db
      .query("projectEnvVars")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    return vars
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(toEnvVarSummary);
  },
});

/**
 * Public variables only, as plain key/value pairs.
 *
 * This is what the WebContainer preview mounts. It returns nothing that is not
 * already destined for the client bundle.
 */
export const listPublicEnvVars = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<Array<{ key: string; value: string }>> => {
    const identity = await verifyAuth(ctx);
    await assertProjectOwner(ctx, args.projectId, identity.subject);

    const vars = await ctx.db
      .query("projectEnvVars")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    return vars
      .filter((row) => row.visibility === "public" && row.plainValue !== undefined)
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((row) => ({ key: row.key, value: row.plainValue as string }));
  },
});

/**
 * How many secret variables exist, without exposing them.
 *
 * Lets the WebContainer preview tell the user "3 secrets are unavailable in this
 * preview" and offer to switch to the cloud sandbox, instead of failing with a
 * confusing runtime error inside the generated app.
 */
export const countWithheldSecrets = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<number> => {
    const identity = await verifyAuth(ctx);
    await assertProjectOwner(ctx, args.projectId, identity.subject);

    const vars = await ctx.db
      .query("projectEnvVars")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    return vars.filter((row) => row.visibility === "secret").length;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutations
//
// Only public values are written here. A secret needs sealing, which requires
// node:crypto and the KEK, so it goes through the API route and system.ts.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create or update a public variable.
 *
 * Rejects keys that are not public by convention: accepting `DATABASE_URL`
 * through a client-callable mutation would store a secret in plaintext, and the
 * request originates in the browser where we cannot seal it anyway.
 */
export const setPublicEnvVar = mutation({
  args: {
    projectId: v.id("projects"),
    key: v.string(),
    value: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    await assertProjectOwner(ctx, args.projectId, identity.subject);

    const key = args.key.trim();
    assertValidEnvKey(key);

    if (!isPublicByConvention(key)) {
      throw new Error(
        `"${key}" is not a recognised public variable name. Public variables must ` +
          `start with one of: ${PUBLIC_KEY_PREFIXES.join(", ")}. ` +
          `Store anything else as a secret instead.`,
      );
    }

    const existing = await ctx.db
      .query("projectEnvVars")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("key", key),
      )
      .first();

    const now = Date.now();

    if (existing) {
      await ctx.db.patch("projectEnvVars", existing._id, {
        visibility: "public",
        plainValue: args.value,
        maskedPreview: args.value,
        // Clear any sealed payload left from when this key was a secret,
        // otherwise the row would carry both and the sandbox resolver would have
        // to guess which is current.
        secretRef: undefined,
        kekProvider: undefined,
        kekKeyId: undefined,
        wrappedDek: undefined,
        ciphertext: undefined,
        iv: undefined,
        authTag: undefined,
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("projectEnvVars", {
      projectId: args.projectId,
      ownerId: identity.subject,
      key,
      visibility: "public",
      plainValue: args.value,
      // A public value is its own preview — there is nothing to hide.
      maskedPreview: args.value,
      source: "manual",
      updatedAt: now,
    });
  },
});

export const deleteEnvVar = mutation({
  args: { id: v.id("projectEnvVars") },
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);

    const row = await ctx.db.get("projectEnvVars", args.id);
    if (!row) {
      throw new Error("Environment variable not found");
    }
    if (row.ownerId !== identity.subject) {
      throw new Error("Unauthorized to delete this environment variable");
    }

    await ctx.db.delete("projectEnvVars", args.id);
  },
});
