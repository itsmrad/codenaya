import type { GetStepTools } from "inngest";
import { type Agent, AgentResult, type StateData, type TextMessage, type Tool } from "@inngest/agent-kit";

import type { inngest } from "@/inngest/client";
import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import type { AgentModelChoice } from "../../agent-models";
import { sanitizeAgentText, toolResultError } from "../../agent-steps";
import { type MessageMode, SWARM_MODE } from "../../plan-mode";
import { FOUNDATION_MAX_STEPS, MAX_SWARM_DEPTH, classifySwarmPrompt } from "../../swarm";
import { SWARM_SOLO_STEP_ID } from "../../swarm-status";
import { SWARM_ORCHESTRATOR_NOTE, SWARM_SUBORCH_OPTION_NOTE } from "../constants";
import { createDelegateTasksTool } from "../tools/delegate-tasks";
import { getProjectFiles, indexProjectFiles, normalizePath } from "../tools/paths";
import { UNFINISHED_REPLY } from "./conversation-history";
import { FOUNDATION_REFUSAL, guardFoundation } from "./ownership-guard";

/** The orchestrator's forced turn: the same agent with tool_choice set to delegateTasks. */
export const SWARM_DELEGATE_AGENT_NAME = "codenaya-delegate";
/** A forced call whose plan is refused is forced once more; after that the run builds solo. */
export const MAX_FORCED_DELEGATIONS = 2;

const FOUNDATION_WRITE_TOOLS = new Set(["writeFiles", "editFile", "updateFile", "scaffoldViteApp"]);
const wrote = (result: AgentResult) =>
  result.toolCalls.some(({ tool, content }) => FOUNDATION_WRITE_TOOLS.has(tool.name) && !toolResultError(content));

/**
 * What the classifier judges: the request plus the earlier requests right before it that
 * never got a usable reply (`priorTurns`' UNFINISHED_REPLY), so Stop then "continue" keeps the original ask.
 */
export const swarmRequest = (earlierTurns: readonly TextMessage[], request: string) => {
  const pending: string[] = [];
  for (let i = earlierTurns.length - 2; i >= 0 && earlierTurns[i + 1].content === UNFINISHED_REPLY; i -= 2) {
    const { content } = earlierTurns[i];
    pending.unshift(typeof content === "string" ? content : content.map((part) => part.text).join(""));
  }
  return [...pending, request].join("\n\n");
};

export interface SwarmRun {
  tools: Tool.Any[];
  promptNote: string;
  /** Wraps every orchestrator tool: before delegation, writes stay in the foundation. */
  guard: (tool: Tool.Any) => Tool.Any;
  /** Whether the router's next call must be the forced delegateTasks turn. */
  forceDelegation: (results: AgentResult[], callCount: number) => boolean;
  /** The forced turn's agent, made to never fail the run: an error falls back to solo, with its reason. */
  catchDelegation: <T extends StateData>(agent: Agent<T>) => Agent<T>;
}

const NO_SWARM: SwarmRun = {
  tools: [], promptNote: "", guard: (tool) => tool, forceDelegation: () => false, catchDelegation: (agent) => agent,
};

/**
 * A swarm-mode run's extra tool, system-prompt note and delegation gate; nothing for
 * other modes, or when the kill switch (ADR 0013) turned swarm off after the send,
 * which then runs as a normal build. SWARM_PLATFORM_MAX_DEPTH bounds a platform
 * run's depth; BYOK always gets MAX_SWARM_DEPTH.
 *
 * `classifySwarmPrompt` decides before the run whether the request is split. A split
 * run writes only the foundation, then its next call is forced to delegateTasks: when
 * a write is refused, a turn writes nothing after earlier writes, it would end, or
 * FOUNDATION_MAX_STEPS ran. A solo run records the classifier's reason for the board.
 */
export const swarmRun = async ({ mode, request, internalKey, messageId, projectId, ownerId, model, step }: {
  mode?: MessageMode;
  /** `swarmRequest`'s text. */
  request: string;
  internalKey: string;
  messageId: Id<"messages">;
  projectId: Id<"projects">;
  ownerId?: string;
  model?: string | AgentModelChoice;
  step: GetStepTools<typeof inngest>;
}): Promise<SwarmRun> => {
  if (mode !== SWARM_MODE) return NO_SWARM;
  const settings = await step.run("swarm-settings", () => convex.query(api.swarm.getSwarmSettings, {}));
  if (!settings.enabled) return NO_SWARM;
  const choice = model && typeof model === "object" ? model : { modelId: model ?? "" };
  const maxDepth = choice.keyId ? MAX_SWARM_DEPTH : settings.platformMaxDepth;
  const split = classifySwarmPrompt(request);
  // The board's "Built solo: <reason>" (`swarmSoloReason`).
  const recordSolo = (reason: string) => step.run("record-swarm-solo", async () => {
    try {
      await convex.mutation(api.system.upsertMessageSteps, {
        internalKey,
        messageId,
        steps: [{ id: SWARM_SOLO_STEP_ID, kind: "thinking", text: `Building solo: ${reason}`, status: "done", startedAt: Date.now() }],
      });
    } catch (error) {
      console.error("[swarm] failed to record the solo reason", error);
    }
  });
  if (!split.delegate) await recordSolo(split.reason);
  const existing = async (paths: string[]) => {
    const { byPath } = indexProjectFiles(await getProjectFiles(internalKey, projectId));
    return paths.find((path) => byPath.get(normalizePath(path) ?? "")?.file) ?? null;
  };

  // Rebuilt on every replay: tool handlers and the router re-run in order.
  const state = { delegated: false };
  let fellBack = false;
  const open = () => !split.delegate || state.delegated || fellBack;
  return {
    tools: [createDelegateTasksTool({
      internalKey,
      messageId,
      projectId,
      // Swarm sends all carry the owner (#242); it keys the workers' concurrency.
      ownerId: ownerId ?? "",
      model: choice,
      maxDepth,
      state,
      ...(split.delegate ? { soloRefusal: split.reason } : {}),
    })],
    promptNote: SWARM_ORCHESTRATOR_NOTE + (maxDepth >= MAX_SWARM_DEPTH ? SWARM_SUBORCH_OPTION_NOTE : ""),
    guard: guardFoundation(open, existing),
    catchDelegation: (agent) => {
      const run = agent.run.bind(agent);
      agent.run = async (...args) => {
        try {
          return await run(...args);
        } catch (error) {
          // A provider that refuses the forced call (or any error in this turn) must not fail the run.
          fellBack = true;
          const message = sanitizeAgentText(String((error as { message?: unknown } | null)?.message ?? error)).slice(0, 160);
          await recordSolo(`delegation failed (${message})`);
          return new AgentResult(agent.name, [], [], new Date());
        }
      };
      return agent;
    },
    forceDelegation: (results, callCount) => {
      if (open() || callCount === 0) return false;
      // callCount, not results: seeded history is not this run's.
      const run = results.slice(-callCount);
      const forced = run.filter((result) => result.agentName === SWARM_DELEGATE_AGENT_NAME).length;
      // The board shows the last refusal as the solo reason (`swarmSoloReason`).
      if (forced >= MAX_FORCED_DELEGATIONS) {
        fellBack = true;
        return false;
      }
      const last = run.at(-1)!;
      if (last.agentName === SWARM_DELEGATE_AGENT_NAME || callCount >= FOUNDATION_MAX_STEPS) return true;
      if (last.toolCalls.length === 0) return true;
      if (last.toolCalls.some(({ content }) => toolResultError(content)?.startsWith(FOUNDATION_REFUSAL))) return true;
      return !wrote(last) && run.slice(0, -1).some(wrote);
    },
  };
};
