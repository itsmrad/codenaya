import { v } from "convex/values";

import { query } from "./_generated/server";

/** Maximum number of tasks the orchestrator delegates on one assistant message. */
export const MAX_SWARM_TASKS = 4;
/** Maximum number of independently metered agents on one message, sub-orchestrators' workers included. */
export const MAX_SWARM_AGENTS = 8;

/**
 * How deep a platform-model swarm may go: 1 (the default) means no
 * sub-orchestrators, "2" allows them. BYOK swarms always have depth 2 (ADR 0013).
 */
export const platformMaxDepth = () => (process.env.SWARM_PLATFORM_MAX_DEPTH?.trim() === "2" ? 2 : 1);

/** The swarm switches, for the send route and the orchestrator run. Holds no secrets. */
export const getSwarmSettings = query({
  args: {},
  returns: v.object({ platformMaxDepth: v.number() }),
  handler: async () => ({ platformMaxDepth: platformMaxDepth() }),
});
