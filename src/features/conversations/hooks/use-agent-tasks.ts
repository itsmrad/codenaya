import { useQuery } from "convex/react";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

/** Subscribe only for swarm messages; legacy runs never query this table. */
export const useAgentTasks = (messageId: Id<"messages"> | null) =>
  useQuery(api.agentTasks.listForMessage, messageId ? { messageId } : "skip");
