import { v } from "convex/values";

import { query } from "./_generated/server";

/** Maximum number of independently metered workers on one assistant message. */
export const MAX_SWARM_TASKS = 4;

/** Kill switch (ADR 0013): swarm mode is on unless the deployment sets SWARM_ENABLED to "false", "0" or "off". */
export const isEnabled = query({
  args: {},
  returns: v.boolean(),
  handler: async () => !["false", "0", "off"].includes((process.env.SWARM_ENABLED ?? "").trim().toLowerCase()),
});
