import { createAgent, createNetwork } from "@inngest/agent-kit";
import { NonRetriableError } from "inngest";

import { inngest } from "@/inngest/client";
import { convex } from "@/lib/convex-client";
import { getAppError } from "@/lib/convex-error";
import { resolveWorkerModel } from "@/features/ai-providers/server/resolve-run-model";
import { withoutToolCalls } from "@/features/ai-providers/server/agentkit-model";
import { costUsd, usageOfResponse } from "@/features/billing/credits";
import { api } from "../../../../convex/_generated/api";
import { MAX_SWARM_TASKS } from "../../../../convex/swarm";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { AgentModelChoice } from "../agent-models";
import { type AgentStep, runWrittenPaths, stepsFromResponse, stepsFromToolResults, turnHeartbeat } from "../agent-steps";
import { MAX_WORKER_USD, WORKER_MAX_STEPS } from "../swarm";
import { CODING_AGENT_SYSTEM_PROMPT, STEP_BUDGET_NOTE, SWARM_WORKER_NOTE } from "./constants";
import { guardOwnedPaths } from "./lib/ownership-guard";
import { hitOutputLimit, markCutOffCalls, refuseCutOffCalls } from "./lib/output-limit";
import { trimFileHistory } from "./lib/trim-file-history";
import { createDeleteFilesTool } from "./tools/delete-files";
import { createEditFileTool } from "./tools/edit-file";
import { createListFilesTool } from "./tools/list-files";
import { buildProjectTreePromptSection, getProjectFiles } from "./tools/paths";
import { createRegistryCheck } from "./tools/post-write-checks";
import { createReadFilesTool } from "./tools/read-files";
import { createSearchFilesTool } from "./tools/search-files";
import { createWriteFilesTool } from "./tools/write-files";

/** Ids only (ADR 0002): the brief and owned paths are read from the task row. */
export interface SwarmWorkerEvent {
  parentMessageId: Id<"messages">;
  agentTaskId: Id<"agentTasks">;
  projectId: Id<"projects">;
  ownerId: string;
  model: AgentModelChoice;
  planOverview: string;
}

export interface SwarmWorkerResult {
  status: "done" | "unfinished" | "error";
  summary: string;
  writtenPaths: string[];
}

const SUMMARY_AGENT_NAME = "codenaya-summary";

/**
 * One swarm task on its own model and step budget, invoked by the orchestrator
 * with `step.invoke`. Writes only the task's owned paths and runs no build:
 * the orchestrator integrates and checks the whole tree afterwards.
 */
export const swarmWorker = inngest.createFunction(
  {
    id: "swarm-worker",
    // Room for every worker of processMessage's 2 runs per owner: step.invoke's timeout counts queue time.
    concurrency: [{ key: "event.data.ownerId", limit: 2 * MAX_SWARM_TASKS }],
    cancelOn: [{ event: "message/cancel", if: "event.data.messageId == async.data.parentMessageId" }],
    triggers: [{ event: "agent-task/run" }],
    onFailure: async ({ event, step }) => {
      const { agentTaskId } = event.data.event.data as SwarmWorkerEvent;
      const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
      if (!internalKey) return;
      await step.run("fail-worker", () => convex.mutation(api.agentTasks.finishTask, {
        internalKey, agentTaskId, status: "error", error: "The worker could not finish this task.",
      }));
    },
  },
  async ({ event, step }): Promise<SwarmWorkerResult> => {
    const { parentMessageId, agentTaskId, projectId, model, planOverview } = event.data as SwarmWorkerEvent;
    const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
    if (!internalKey) throw new NonRetriableError("CODENAYA_CONVEX_INTERNAL_KEY is not configured");

    const task = await step.run("start-worker", async () => {
      try {
        return await convex.mutation(api.agentTasks.startTask, { internalKey, agentTaskId, parentMessageId, projectId });
      } catch (error) {
        // The row was deleted (a project cascade): nothing left to work for.
        if (getAppError(error)?.code === "NOT_FOUND") return null;
        throw error;
      }
    });
    if (!task) return { status: "error", summary: "The task no longer exists.", writtenPaths: [] };

    // Model closures can hold decrypted BYOK keys: resolve in the body, never in a step.
    const runModel = await resolveWorkerModel({ internalKey, projectId, choice: model });
    if (runModel.checkKey) {
      const { rejected } = await step.run("check-worker-key", runModel.checkKey);
      if (rejected) throw new NonRetriableError("The worker's AI provider key was rejected");
    }
    const tree = await step.run("worker-project-tree", async () =>
      buildProjectTreePromptSection(await getProjectFiles(internalKey, projectId)));

    const recorded = new Map<string, AgentStep>();
    // Also beats the parent's heartbeat, so the stalled-run reaper sees the orchestrator alive.
    const recordSteps = async (id: string, steps: AgentStep[]) => {
      for (const row of steps) recorded.set(row.id, { ...recorded.get(row.id), ...row });
      await step.run(id, async () => {
        if (steps.length) await convex.mutation(api.agentTasks.upsertTaskSteps, { internalKey, agentTaskId, steps });
        await convex.mutation(api.system.upsertMessageSteps, {
          internalKey, messageId: parentMessageId, steps: [turnHeartbeat(Date.now())],
        });
      });
    };

    // Running totals, rebuilt on replay, as in processMessage (ADR 0011).
    const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    let turn = 0;
    let cutOff = false;
    let unfinished = false;
    const options = { internalKey, projectId, registry: createRegistryCheck() };
    const codingModel = runModel.coding(0.3);
    const agentOptions: Parameters<typeof createAgent>[0] = {
      name: "swarm-worker",
      system: [CODING_AGENT_SYSTEM_PROMPT, SWARM_WORKER_NOTE, tree, planOverview,
        `## Your task: ${task.title}\nOwned paths: ${task.ownedPaths.join(", ")}`].join("\n\n"),
      model: codingModel,
      tools: [
        createListFilesTool(options), createReadFilesTool(options), createSearchFilesTool(options),
        ...[createWriteFilesTool(options), createEditFileTool(options), createDeleteFilesTool(options)]
          .map(guardOwnedPaths(task.ownedPaths)),
      ].map(refuseCutOffCalls),
      lifecycle: {
        onStart: async ({ agent, prompt, history }) => {
          await recordSteps("worker-turn-start", []);
          const note = agent.name === SUMMARY_AGENT_NAME ? [{ type: "text" as const, role: "user" as const, content: STEP_BUDGET_NOTE }] : [];
          return { prompt, history: [...trimFileHistory(history ?? []), ...note], stop: false };
        },
        onResponse: async ({ agent, result }) => {
          turn += 1;
          const tokens = usageOfResponse(result.raw);
          usage.inputTokens += tokens.inputTokens;
          usage.outputTokens += tokens.outputTokens;
          usage.costUsd += runModel.metering.coding ? costUsd(runModel.metering.coding, tokens) : 0;
          const totals = { ...usage };
          await step.run(`worker-usage-${turn}`, async () => {
            try {
              await convex.mutation(api.credits.recordRunUsage, {
                internalKey, messageId: parentMessageId, agentTaskId, source: runModel.metering.source, ...totals,
              });
            } catch (error) {
              console.error("[credits] failed to record worker usage", error);
            }
          });
          if (agent.name === SUMMARY_AGENT_NAME) result.output = result.output.filter((m) => m.type !== "tool_call");
          await recordSteps("worker-response", stepsFromResponse(result, turn, Date.now()));
          cutOff = hitOutputLimit(result.raw);
          if (cutOff) markCutOffCalls(result.output);
          return result;
        },
        onFinish: async ({ result }) => {
          if (result.toolCalls.length) await recordSteps("worker-tool-results", stepsFromToolResults(result.toolCalls, Date.now()));
          return result;
        },
      },
    };
    const worker = createAgent(agentOptions);
    // Same tools so the history's tool calls stay valid; the model is barred from calling them.
    const summaryAgent = createAgent({ ...agentOptions, name: SUMMARY_AGENT_NAME, model: withoutToolCalls(codingModel) });
    const network = createNetwork({
      name: "swarm-worker-network",
      agents: [worker, summaryAgent],
      maxIter: WORKER_MAX_STEPS,
      router: ({ network, callCount }) => {
        const last = network.state.results.at(-1);
        if (last?.agentName === SUMMARY_AGENT_NAME) return undefined;
        const hasCalls = last?.output.some((m) => m.type === "tool_call");
        const hasText = last?.output.some((m) => m.type === "text" && m.role === "assistant");
        if (last && hasText && !hasCalls && !cutOff) return undefined;
        // BYOK is unpriced, so only the step cap bounds it.
        if (callCount >= WORKER_MAX_STEPS - 1 || usage.costUsd >= MAX_WORKER_USD) {
          unfinished = true;
          return summaryAgent;
        }
        return worker;
      },
    });

    const result = await network.run(task.brief);
    const summary = result.state.results.at(-1)?.output.flatMap((m) => m.type === "text" && m.role === "assistant"
      ? [typeof m.content === "string" ? m.content : m.content.map((c) => c.text).join("")] : []).join("\n").trim()
      || "The worker finished without a summary.";
    await step.run("finish-worker", () => convex.mutation(api.agentTasks.finishTask, {
      internalKey, agentTaskId, status: "done", summary,
    }));
    return { status: unfinished ? "unfinished" : "done", summary, writtenPaths: runWrittenPaths([...recorded.values()]) };
  },
);
