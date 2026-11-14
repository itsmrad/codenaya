import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

/** Subscribe only for swarm messages; legacy runs never query this table. */
export const useAgentTasks = (messageId: Id<"messages"> | null) =>
  useQuery(api.agentTasks.listForMessage, messageId ? { messageId } : "skip");

// ponytail: typed by hand until S3 (#515) lands `api.swarm.isEnabled`; swap to it then.
const isSwarmEnabled = makeFunctionReference<"query", Record<string, never>, boolean>("swarm:isEnabled");

/** The SWARM_ENABLED kill switch; false while loading, so Swarm never flashes in. */
export const useSwarmEnabled = () => useQuery(isSwarmEnabled, {}) === true;
