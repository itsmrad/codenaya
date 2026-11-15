import type { GetStepTools } from "inngest";
import type { Tool } from "@inngest/agent-kit";

import type { inngest } from "@/inngest/client";
import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import type { AgentModelChoice } from "../../agent-models";
import { type MessageMode, SWARM_MODE } from "../../plan-mode";
import { MAX_SWARM_DEPTH } from "../../swarm";
import { SWARM_ORCHESTRATOR_NOTE, SWARM_SUBORCH_OPTION_NOTE } from "../constants";
import { createDelegateTasksTool } from "../tools/delegate-tasks";

/**
 * A swarm-mode run's extra tool and system-prompt note; nothing for other
 * modes, or when the kill switch (ADR 0013) turned swarm off after the send,
 * which then runs as a normal build. SWARM_PLATFORM_MAX_DEPTH bounds a platform
 * run's depth; BYOK always gets MAX_SWARM_DEPTH.
 */
export const swarmRun = async ({ mode, internalKey, messageId, projectId, ownerId, model, step }: {
  mode?: MessageMode;
  internalKey: string;
  messageId: Id<"messages">;
  projectId: Id<"projects">;
  ownerId?: string;
  model?: string | AgentModelChoice;
  step: GetStepTools<typeof inngest>;
}): Promise<{ tools: Tool.Any[]; promptNote: string }> => {
  if (mode !== SWARM_MODE) return { tools: [], promptNote: "" };
  const settings = await step.run("swarm-settings", () => convex.query(api.swarm.getSwarmSettings, {}));
  if (!settings.enabled) return { tools: [], promptNote: "" };
  const choice = model && typeof model === "object" ? model : { modelId: model ?? "" };
  const maxDepth = choice.keyId ? MAX_SWARM_DEPTH : settings.platformMaxDepth;
  return {
    tools: [createDelegateTasksTool({
      internalKey,
      messageId,
      projectId,
      // Swarm sends all carry the owner (#242); it keys the workers' concurrency.
      ownerId: ownerId ?? "",
      model: choice,
      maxDepth,
    })],
    promptNote: SWARM_ORCHESTRATOR_NOTE + (maxDepth >= MAX_SWARM_DEPTH ? SWARM_SUBORCH_OPTION_NOTE : ""),
  };
};
