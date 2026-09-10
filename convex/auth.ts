import { UserIdentity } from "convex/server";

import { MutationCtx, QueryCtx } from "./_generated/server";

/**
 * Local-only escape hatch for working on the UI without a Clerk instance.
 *
 * Every query and mutation in this deployment goes through `verifyAuth`, so
 * with no identity provider the app is unusable end to end — you cannot even
 * create a project to open the IDE against. Setting `CODENAYA_DEV_AUTH_BYPASS`
 * on the deployment substitutes a fixed identity instead.
 *
 * Set it only on a local/anonymous deployment. Any deployment that has it set
 * treats every caller as the same user, so all data is shared and unprotected.
 */
const DEV_IDENTITY = {
  subject: "dev-user",
  issuer: "https://dev.local",
  tokenIdentifier: "https://dev.local|dev-user",
  name: "Dev User",
  pictureUrl: undefined,
} as unknown as UserIdentity;

export const verifyAuth = async (ctx: QueryCtx | MutationCtx) => {
  const identity = await ctx.auth.getUserIdentity();

  if (!identity) {
    if (process.env.CODENAYA_DEV_AUTH_BYPASS === "1") {
      return DEV_IDENTITY;
    }

    throw new Error("Unauthorized");
  }

  return identity;
};
