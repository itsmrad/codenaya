import type { Tool } from "@inngest/agent-kit";

import type { Id } from "../../../../../convex/_generated/dataModel";
import type { AgentModelChoice } from "../../agent-models";
import { type MessageMode, SWARM_MODE } from "../../plan-mode";
import { SWARM_ORCHESTRATOR_NOTE } from "../constants";
import { createDelegateTasksTool } from "../tools/delegate-tasks";

/** A swarm-mode run's extra tool and system-prompt note; nothing for other modes. */
export const swarmRun = ({ mode, internalKey, messageId, projectId, ownerId, model }: {
  mode?: MessageMode;
  internalKey: string;
  messageId: Id<"messages">;
  projectId: Id<"projects">;
  ownerId?: string;
  model?: string | AgentModelChoice;
}): { tools: Tool.Any[]; promptNote: string } =>
  mode === SWARM_MODE
    ? {
        tools: [createDelegateTasksTool({
          internalKey,
          messageId,
          projectId,
          // Swarm sends all carry the owner (#242); it keys the workers' concurrency.
          ownerId: ownerId ?? "",
          model: model && typeof model === "object" ? model : { modelId: model ?? "" },
        })],
        promptNote: SWARM_ORCHESTRATOR_NOTE,
      }
    : { tools: [], promptNote: "" };
