import type { GetStepTools } from "inngest";
import type { Tool } from "@inngest/agent-kit";

import type { inngest } from "@/inngest/client";
import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import type { AgentModelChoice } from "../../agent-models";
import { type MessageMode, SWARM_MODE } from "../../plan-mode";
import { SWARM_ORCHESTRATOR_NOTE } from "../constants";
import { createDelegateTasksTool } from "../tools/delegate-tasks";

/**
 * A swarm-mode run's extra tool and system-prompt note; nothing for other
 * modes, or when the kill switch (ADR 0013) turned swarm off after the send,
 * which then runs as a normal build.
 */
export const swarmRun = async ({ mode, internalKey, messageId, projectId, ownerId, model, step }: {
  mode?: MessageMode;
  internalKey: string;
  messageId: Id<"messages">;
  projectId: Id<"projects">;
  ownerId?: string;
  model?: string | AgentModelChoice;
  step: GetStepTools<typeof inngest>;
}): Promise<{ tools: Tool.Any[]; promptNote: string }> =>
  mode === SWARM_MODE && await step.run("check-swarm-enabled", () => convex.query(api.swarm.isEnabled, {}))
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
