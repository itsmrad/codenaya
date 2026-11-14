import { v } from "convex/values";

import { MutationCtx, QueryCtx, mutation, query } from "./_generated/server";
import { verifyAuth } from "./auth";
import { workspaceModeValidator } from "./schema";

/** Account-level workspace settings (#524); each user reads and writes only their own row. */

const getWorkspaceRow = (ctx: QueryCtx | MutationCtx, userId: string) =>
  ctx.db
    .query("userWorkspacePreferences")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();

/** The signed-in user's workspace mode; "ide" until they pick one. */
export const getWorkspaceMode = query({
  args: {},
  returns: workspaceModeValidator,
  handler: async (ctx) => {
    const identity = await verifyAuth(ctx);
    const row = await getWorkspaceRow(ctx, identity.subject);
    return row?.workspaceMode ?? "ide";
  },
});

export const setWorkspaceMode = mutation({
  args: { workspaceMode: workspaceModeValidator },
  returns: v.null(),
  handler: async (ctx, { workspaceMode }) => {
    const identity = await verifyAuth(ctx);
    const row = await getWorkspaceRow(ctx, identity.subject);
    const fields = { workspaceMode, updatedAt: Date.now() };
    if (row) {
      await ctx.db.patch("userWorkspacePreferences", row._id, fields);
    } else {
      await ctx.db.insert("userWorkspacePreferences", { userId: identity.subject, ...fields });
    }
    return null;
  },
});
