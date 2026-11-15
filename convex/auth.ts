import { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { appError } from "./errors";

export const verifyAuth = async (ctx: QueryCtx | MutationCtx | ActionCtx) => {
  const identity = await ctx.auth.getUserIdentity();

  if (!identity) {
    throw appError("UNAUTHENTICATED", "Unauthorized");
  }

  return identity;
};
