import { v } from "convex/values";

import { query } from "./_generated/server";

/** Maximum number of tasks the orchestrator delegates on one assistant message. */
export const MAX_SWARM_TASKS = 4;
/** Maximum number of independently metered agents on one message, sub-orchestrators' workers included. */
export const MAX_SWARM_AGENTS = 8;

/** Kill switch (ADR 0013): swarm mode is on unless the deployment sets SWARM_ENABLED to "false", "0" or "off". */
const swarmEnabled = () => !["false", "0", "off"].includes((process.env.SWARM_ENABLED ?? "").trim().toLowerCase());

/**
 * How deep a platform-model swarm may go: 1 (the default) means no
 * sub-orchestrators, "2" allows them. BYOK swarms always have depth 2 (ADR 0013).
 */
export const platformMaxDepth = () => (process.env.SWARM_PLATFORM_MAX_DEPTH?.trim() === "2" ? 2 : 1);

export const isEnabled = query({
  args: {},
  returns: v.boolean(),
  handler: async () => swarmEnabled(),
});

/** Both swarm switches, for the orchestrator run. Holds no secrets. */
export const getSwarmSettings = query({
  args: {},
  returns: v.object({ enabled: v.boolean(), platformMaxDepth: v.number() }),
  handler: async () => ({ enabled: swarmEnabled(), platformMaxDepth: platformMaxDepth() }),
});
