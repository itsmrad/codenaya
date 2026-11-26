import { PERMISSION_STOP_REPLY, InferencePermissionMiddleware } from "@/features/billing/server/platform-permission";
import { createAgent, createNetwork } from "@inngest/agent-kit";
import { NonRetriableError } from "inngest";

import { localCandidates, RESOLVE_SUFFIXES } from "@/features/sandbox-preview/utils/missing-references";
import { projectChecks } from "@/features/sandbox-preview/utils/project-checks";
import { INNGEST_PLAN_CONCURRENCY_LIMIT, inngest } from "@/inngest/client";
import { convex } from "@/lib/convex-client";
import { getAppError } from "@/lib/convex-error";
import { resolveInferenceRunModel } from "@/features/ai-providers/server/resolve-run-model";
import { withoutToolCalls, withPromptCache } from "@/features/ai-providers/server/agentkit-model";
import { costUsd, creditsForCost, usageOfResponse } from "@/features/billing/credits";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { AgentModelChoice } from "../agent-models";
import { type AgentStep, buildPathIndex, runWrittenPaths, stepsFromResponse, stepsFromToolResults, turnHeartbeat } from "../agent-steps";
import {
  FOUNDATION_PLACEHOLDER_MAX_CHARS, isFoundationPath, ownsPath,
  CHILD_WORKER_TIMEOUT_MS, MAX_SUBORCH_USD, MAX_SWARM_AGENTS, MAX_SWARM_DEPTH, MAX_WORKER_USD,
  SUBORCH_MAX_STEPS, SUBORCH_TIMEOUT_MS, WORKER_MAX_STEPS, WORKER_TIMEOUT_MS,
} from "../swarm";
import { selfCheckStep, selfCheckWorker } from "../swarm-sandbox";
import { CODING_AGENT_SYSTEM_PROMPT, OUT_OF_CREDITS_NOTE, OUT_OF_CREDITS_REPLY, STEP_BUDGET_NOTE, SWARM_SUBORCH_NOTE, SWARM_WORKER_NOTE } from "./constants";
import { splitSuggestions } from "../suggestions";
import { runCreditLimit } from "./lib/run-credit-limit";
import { decodeJsonArgs, decodeToolCalls } from "./lib/json-args";
import { guardOwnedPaths } from "./lib/ownership-guard";
import { hitOutputLimit, markCutOffCalls, refuseCutOffCalls } from "./lib/output-limit";
import { trimFileHistory } from "./lib/trim-file-history";
import { createDelegateTasksTool } from "./tools/delegate-tasks";
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
  parentAgentTaskId?: Id<"agentTasks">;
  projectId: Id<"projects">;
  ownerId: string;
  model: AgentModelChoice;
  planOverview: string;
  /** Other tasks in this plan; absent on events queued before static ownership checks. */
  siblingOwnedPaths?: string[];
  /** The user's request (already capped), context only: the worker builds just its task. */
  originalPrompt?: string;
  /** 1 for the orchestrator's tasks (the default), 2 for a sub-orchestrator's. */
  depth?: number;
}

export interface SwarmWorkerResult {
  status: "done" | "unfinished" | "error";
  summary: string;
  writtenPaths: string[];
  /** The optional sandbox self-check's outcome: never "verified" (swarm-sandbox.ts). */
  selfCheck?: string;
}

const SUMMARY_AGENT_NAME = "codenaya-summary";

/** At most one parent heartbeat write per worker this often; far under STALLED_RUN_MS. */
export const WORKER_HEARTBEAT_MS = 20_000;
// Per task, across this instance's requests (a closure resets every request).
// ponytail: a cold instance beats once more; the write is idempotent.
const lastHeartbeat = new Map<string, number>();

/**
 * One swarm task on its own model and step budget, invoked by the orchestrator
 * with `step.invoke`. Writes only the task's owned paths and runs no build:
 * the orchestrator integrates and checks the whole tree afterwards.
 */
export const swarmWorker = inngest.createFunction(
  {
    id: "swarm-worker",
    middleware: [InferencePermissionMiddleware],
    // Room for every agent of processMessage's 2 runs per owner: step.invoke's timeout counts queue time.
    // The limit counts executing steps, and a sub-orchestrator waiting on step.invoke holds none.
    // shortcut: capped at the plan limit, so extra workers queue; raise it with the Inngest plan.
    concurrency: [{ key: "event.data.ownerId", limit: Math.min(2 * MAX_SWARM_AGENTS, INNGEST_PLAN_CONCURRENCY_LIMIT) }],
    // `event` is this run's trigger, `async` the cancel event. A cancel skips
    // onFailure; the board shows the task cancelled from its parent message.
    // `agent-task/cancel`: the orchestrator stops a worker whose step.invoke timed out.
    cancelOn: [
      { event: "message/cancel", if: "event.data.parentMessageId == async.data.messageId" },
      // One entry per event: the task itself, or a depth-2 child of that sub-orchestrator.
      {
        event: "agent-task/cancel",
        if: "event.data.agentTaskId == async.data.agentTaskId || event.data.parentAgentTaskId == async.data.agentTaskId",
      },
    ],
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
    const { parentMessageId, agentTaskId, projectId, ownerId, model, planOverview, siblingOwnedPaths, originalPrompt, depth = 1 } = event.data as SwarmWorkerEvent;
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
    const { model: runModel, permission } = await resolveInferenceRunModel({ internalKey, projectId, choice: { ...model, modelId: task.modelId }, role: task.role ?? "worker" });
    // shortcut: each worker snapshots the full balance, so a swarm can overshoot ~9x; add shared reservations to bound aggregate spend.
    const creditLimit = await step.run("get-worker-credit-limit", () =>
      runCreditLimit(internalKey, projectId, runModel.metering.source));
    const outOfCredits = () => creditLimit !== null && creditsForCost(usage.costUsd) >= creditLimit;
    let creditStopped = false;
    if (runModel.checkKey) {
      const { rejected } = await step.run("check-worker-key", runModel.checkKey);
      if (rejected) throw new NonRetriableError("The worker's AI provider key was rejected");
    }
    const tree = await step.run("worker-project-tree", async () =>
      buildProjectTreePromptSection(await getProjectFiles(internalKey, projectId)));

    const recorded = new Map<string, AgentStep>();
    // Also beats the parent's heartbeat (throttled), so the stalled-run reaper sees the orchestrator alive.
    const recordSteps = async (id: string, steps: AgentStep[]) => {
      for (const row of steps) recorded.set(row.id, { ...recorded.get(row.id), ...row });
      await step.run(id, async () => {
        if (steps.length) await convex.mutation(api.agentTasks.upsertTaskSteps, { internalKey, agentTaskId, steps });
        const now = Date.now();
        if (now - (lastHeartbeat.get(agentTaskId) ?? 0) < WORKER_HEARTBEAT_MS) return;
        lastHeartbeat.set(agentTaskId, now);
        await convex.mutation(api.system.upsertMessageSteps, {
          internalKey, messageId: parentMessageId, steps: [turnHeartbeat(now)],
        });
      });
    };

    // Running totals, rebuilt on replay, as in processMessage (ADR 0011).
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
    let turn = 0;
    let cutOff = false;
    let unfinished = false;
    let staticChecked = false;
    let staticFixNote = "";
    let repairNeeds = "";
    const options = { internalKey, projectId, messageId: parentMessageId, registry: createRegistryCheck() };
    const subOrchestrator = task.role === "sub-orchestrator" && depth < MAX_SWARM_DEPTH;
    // Shared by every worker of the run, so they share its cache; the task line goes after it.
    const sharedSystem = [CODING_AGENT_SYSTEM_PROMPT, subOrchestrator ? SWARM_SUBORCH_NOTE : SWARM_WORKER_NOTE, tree, planOverview,
      ...(originalPrompt ? [`## The user's original request (context, build only your task)\n${originalPrompt}`] : []), ""].join("\n\n");
    const codingModel = withPromptCache(runModel.coding(0.3), sharedSystem);
    const maxSteps = subOrchestrator ? SUBORCH_MAX_STEPS : WORKER_MAX_STEPS;
    const maxUsd = subOrchestrator ? MAX_SUBORCH_USD : MAX_WORKER_USD;
    const recordUsage = async (raw: string | undefined, id: string) => {
      const tokens = usageOfResponse(raw);
      usage.inputTokens += tokens.inputTokens;
      usage.outputTokens += tokens.outputTokens;
      usage.cacheReadTokens += tokens.cacheReadTokens ?? 0;
      usage.cacheWriteTokens += tokens.cacheWriteTokens ?? 0;
      usage.costUsd += runModel.metering.coding ? costUsd(runModel.metering.coding, tokens) : 0;
      const totals = { ...usage };
      await step.run(id, async () => {
        try {
          await convex.mutation(api.credits.recordRunUsage, {
            internalKey, messageId: parentMessageId, agentTaskId, source: runModel.metering.source,
            modelId: runModel.codingModel.id, model: runModel.codingModel.label, ...totals,
          });
        } catch (error) {
          console.error("[credits] failed to record worker usage", error);
        }
      });
    };
    // Rebuilt on replay with the memoized invoke results, like `recorded`.
    const childWrites: string[] = [];
    const agentOptions: Parameters<typeof createAgent>[0] = {
      name: "swarm-worker",
      system: `${sharedSystem}## Your task: ${task.title}\nOwned paths: ${task.ownedPaths.join(", ")}`,
      model: codingModel,
      tools: [
        createListFilesTool(options), createReadFilesTool(options), createSearchFilesTool(options),
        ...[createWriteFilesTool(options), createEditFileTool(options), createDeleteFilesTool(options)]
          .map(guardOwnedPaths(task.ownedPaths)),
        ...(subOrchestrator ? [createDelegateTasksTool({
          internalKey, projectId, messageId: parentMessageId, ownerId, model, originalPrompt,
          parent: { taskId: task.taskId, agentTaskId, ownedPaths: task.ownedPaths, depth }, writtenPaths: childWrites,
        })] : []),
      ].map(refuseCutOffCalls).map(decodeJsonArgs),
      lifecycle: {
        onStart: async ({ agent, prompt, history }) => {
          await recordSteps("worker-turn-start", []);
          const note = agent.name === SUMMARY_AGENT_NAME ? [{ type: "text" as const, role: "user" as const, content: creditStopped ? OUT_OF_CREDITS_NOTE : STEP_BUDGET_NOTE }] : [];
          const fix = staticFixNote ? [{ type: "text" as const, role: "user" as const, content: staticFixNote }] : [];
          staticFixNote = "";
          return { prompt, history: [...trimFileHistory(history ?? []), ...note, ...fix], stop: false };
        },
        onResponse: async ({ agent, result }) => {
          decodeToolCalls(result.output);
          turn += 1;
          await recordUsage(result.raw, `worker-usage-${turn}`);
          if (agent.name === SUMMARY_AGENT_NAME) result.output = result.output.filter((m) => m.type !== "tool_call");
          await recordSteps("worker-response", stepsFromResponse(result, turn, Date.now()));
          cutOff = hitOutputLimit(result.raw);
          if (cutOff) markCutOffCalls(result.output);
          return result;
        },
        onFinish: async ({ agent, result }) => {
          if (result.toolCalls.length) await recordSteps("worker-tool-results", stepsFromToolResults(result.toolCalls, Date.now()));
          const finishing = result.output.some((m) => m.type === "text" && m.role === "assistant") &&
            !result.output.some((m) => m.type === "tool_call") && !cutOff;
          const written = new Set(runWrittenPaths([...recorded.values()]));
          if (agent.name !== SUMMARY_AGENT_NAME && finishing && written.size && !staticChecked &&
              turn < maxSteps - 1 && usage.costUsd < maxUsd && !outOfCredits()) {
            staticChecked = true;
            const problems = await step.run("worker-static-check", async () => {
              try {
                const rows = await convex.query(api.files.getBuildFiles, { internalKey, projectId });
                const pathOf = buildPathIndex(rows);
                const paths = new Set<string>();
                const files: { path: string; content: string }[] = [];
                for (const row of rows) {
                  const path = row.type === "file" ? pathOf(row._id) : undefined;
                  if (!path) continue;
                  paths.add(path);
                  if (typeof row.content === "string") files.push({ path, content: row.content });
                }
                const shared = (path: string) => (path.startsWith("src/") && isFoundationPath(path)) ||
                  path.startsWith("src/data/") || path.startsWith("src/components/shared/");
                const sibling = (path: string) => ownsPath(siblingOwnedPaths ?? [], path);
                const own = (path: string) => ownsPath(task.ownedPaths, path);
                // Retain the manifest for projectChecks' Next.js skip; withhold uncertain export targets.
                const checkFiles = files.filter((f) => f.path === "package.json" || own(f.path) ||
                  (depth === 1 && siblingOwnedPaths !== undefined && !sibling(f.path) && shared(f.path) &&
                    f.content.length > FOUNDATION_PLACEHOLDER_MAX_CHARS));
                const findings = projectChecks(checkFiles, paths, written);
                const missing = findings.filter((f) => f.checkId === "import").map((f) => f.message).filter((message) => {
                  const file = files.find((f) => written.has(f.path) && message.endsWith(` (imported by ${f.path})`));
                  if (!file) return false;
                  const specifier = message.slice(0, -` (imported by ${file.path})`.length);
                  const targets = localCandidates(file.path, specifier)?.flatMap((candidate) =>
                    RESOLVE_SUFFIXES.map((suffix) => candidate + suffix)).filter((path) => /^(src|public)\//.test(path)) ?? [];
                  // Old events and nested plans cannot prove that an outside path has no owner.
                  return targets.some(own) || (depth === 1 && siblingOwnedPaths !== undefined && targets.length > 0 &&
                    targets.every((path) => !sibling(path) && !shared(path)));
                });
                const exports = findings.filter((f) => f.checkId === "export" &&
                  [...written].some((path) => f.message.startsWith(`${path}:`) || f.message.startsWith(`${path} imports `)))
                  .map((f) => f.message);
                return [...missing, ...exports].slice(0, 10);
              } catch {
                // Advisory only: a failed snapshot must not prevent the handoff.
                return [];
              }
            });
            if (problems.length) {
              const firstSummary = result.output.flatMap((m) => m.type === "text" && m.role === "assistant"
                ? [typeof m.content === "string" ? m.content : m.content.map((c) => c.text).join("")] : []).join("\n");
              repairNeeds = splitSuggestions(firstSummary).content.match(/^NEEDS:[\s\S]*/m)?.[0].trim() ?? "";
              staticFixNote = `Fix these before finishing (within your owned paths; report missing shared contracts in NEEDS):\n- ${problems.join("\n- ")}\n` +
                "Read the shared contract files you use (src/types/*, src/data/*, src/components/shared/*) ONCE; verify exact field/export names and that your page's export matches src/App.tsx. " +
                "Give the FULL final summary again, including any NEEDS: lines for dependencies, shared edits, or integration requirements.";
            }
          }
          return result;
        },
      },
    };
    const worker = permission.wrap(createAgent(agentOptions), runModel.codingModel.id);
    // Same tools so the history's tool calls stay valid; the model is barred from calling them.
    const summaryAgent = permission.wrap(createAgent({ ...agentOptions, name: SUMMARY_AGENT_NAME, model: withoutToolCalls(codingModel) }), runModel.codingModel.id);
    const network = createNetwork({
      name: "swarm-worker-network",
      agents: [worker, summaryAgent],
      maxIter: maxSteps,
      router: ({ network, callCount }) => {
        if (permission.stopped) return undefined;
        const last = network.state.results.at(-1);
        if (last?.agentName === SUMMARY_AGENT_NAME) return undefined;
        const hasCalls = last?.output.some((m) => m.type === "tool_call");
        const hasText = last?.output.some((m) => m.type === "text" && m.role === "assistant");
        if (outOfCredits()) {
          creditStopped = true;
          if (hasText && !hasCalls) return undefined;
          unfinished = true;
          return summaryAgent;
        }
        if (last && hasText && !hasCalls && !cutOff && !staticFixNote) return undefined;
        // BYOK is unpriced, so only the step cap bounds it.
        if (callCount >= maxSteps - 1 || usage.costUsd >= maxUsd) {
          unfinished = true;
          return summaryAgent;
        }
        return worker;
      },
    });

    const result = await network.run(task.brief).catch((error: unknown) => {
      if (!permission.stopped) throw error;
      return undefined;
    });
    const raw = result?.state.results.at(-1)?.output.flatMap((m) => m.type === "text" && m.role === "assistant"
      ? [typeof m.content === "string" ? m.content : m.content.map((c) => c.text).join("")] : []).join("\n").trim() ?? "";
    // The shared prompt asks for follow-up chips (#256); a worker's are never shown.
    let reply = splitSuggestions(raw).content || "The worker finished without a summary.";
    if (repairNeeds && !/^NEEDS:/m.test(reply)) reply += `\n${repairNeeds}`;
    const repairBudget = new AbortController();
    if (permission.stopped || usage.costUsd >= maxUsd || outOfCredits()) repairBudget.abort();
    let repairTurn = 0;
    const check = await selfCheckWorker({
      step, internalKey, projectId, messageId: parentMessageId, agentTaskId, ownedPaths: task.ownedPaths,
      // step.invoke's timeout runs from this event; read only inside a memoized step.
      invokedAt: event.ts ?? Date.now(),
      timeoutMs: depth >= MAX_SWARM_DEPTH ? CHILD_WORKER_TIMEOUT_MS : subOrchestrator ? SUBORCH_TIMEOUT_MS : WORKER_TIMEOUT_MS,
      permission, modelId: runModel.codingModel.id,
      model: codingModel, onEvent: (event) => recordSteps("worker-self-check", [selfCheckStep(event, Date.now())]),
      signal: repairBudget.signal,
      onResponse: async (raw) => {
        await recordUsage(raw, `worker-self-check-usage-${++repairTurn}`);
        if (outOfCredits()) {
          creditStopped = true;
          unfinished = true;
        }
        if (permission.stopped || usage.costUsd >= maxUsd || outOfCredits()) repairBudget.abort();
      },
    });
    // Stored as done: what it wrote is real; the orchestrator reads the prefix.
    const summary = permission.stopped ? PERMISSION_STOP_REPLY : creditStopped ? `${OUT_OF_CREDITS_REPLY}\n\n${reply}` : unfinished ? `Unfinished (step or cost cap): ${reply}` : reply;
    lastHeartbeat.delete(agentTaskId);
    await step.run("finish-worker", () => convex.mutation(api.agentTasks.finishTask, {
      internalKey, agentTaskId, status: "done", summary, selfCheck: check?.selfCheck,
    }));
    const writtenPaths = [...new Set([...childWrites, ...runWrittenPaths([...recorded.values()]), ...(check?.filesChanged ?? [])])];
    return {
      status: permission.stopped || unfinished ? "unfinished" : "done", summary, writtenPaths, ...(check ? { selfCheck: check.selfCheck } : {}),
    };
  },
);
