import { v } from "convex/values";

import { mutation } from "./_generated/server";
import { validateInternalKey } from "./internalKey";

/**
 * Adds an email to the Pro launch waitlist (#250), once per address. Called
 * by /api/waitlist, which validates and rate-limits the request; a signed-in
 * caller's Clerk id is attached to the row.
 */
export const join = mutation({
  args: {
    internalKey: v.string(),
    email: v.string(),
    userId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    const email = args.email.trim().toLowerCase();

    const existing = await ctx.db
      .query("proWaitlist")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (existing) {
      // Keep the first sign-up; only learn the account if we didn't know it.
      if (args.userId && !existing.userId) {
        await ctx.db.patch("proWaitlist", existing._id, { userId: args.userId });
      }
      return null;
    }

    await ctx.db.insert("proWaitlist", {
      email,
      ...(args.userId ? { userId: args.userId } : {}),
      createdAt: Date.now(),
    });
    return null;
  },
});
