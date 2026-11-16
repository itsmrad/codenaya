import { createTool } from "@inngest/agent-kit";

import { resolveWorkerModel } from "@/features/ai-providers/server/resolve-run-model";
import { inngest } from "@/inngest/client";
import { convex } from "@/lib/convex-client";
import { getAppError } from "@/lib/convex-error";

import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import type { AgentModelChoice } from "../../agent-models";
import {
  CHILD_WORKER_TIMEOUT_MS, MAX_SWARM_AGENTS, MAX_SWARM_DEPTH, SUBORCH_TIMEOUT_MS, type SwarmPlan,
  WORKER_TIMEOUT_MS, capOriginalPrompt, swarmPlanSchema, validatePlan,
} from "../../swarm";
import { cleanupSwarmSandboxes, seedSwarmSnapshot } from "../../swarm-sandbox";
import { type SwarmWorkerEvent, type SwarmWorkerResult, swarmWorker } from "../swarm-worker";
import { folderEnsurer, folderPaths, getProjectFiles, indexProjectFiles, lockedPathError, splitPath } from "./paths";

interface DelegateTasksToolOptions {
  internalKey: string;
  projectId: Id<"projects">;
  messageId: Id<"messages">;
  ownerId: string;
  model: AgentModelChoice;
  /** The user's request (`swarmRequest`), handed to each worker; capped by `capOriginalPrompt`. */
  originalPrompt?: string;
  /** A sub-orchestrator's call (depth 1): its task, whose owned paths its workers split. */
  parent?: { taskId: string; agentTaskId: Id<"agentTasks">; ownedPaths: string[]; depth: number };
  /** Collects the paths its workers wrote, for the sub-orchestrator's own report. */
  writtenPaths?: string[];
  /** How deep this run's swarm may go (see `validatePlan`); Convex enforces it too. */
  maxDepth?: number;
  /** Shared with the swarm gate (`swarmRun`), which reads `delegated`. */
  state?: { delegated: boolean };
  /** Set when the request must be split: a solo call is refused with this reason. */
  soloRefusal?: string;
}

type Task = SwarmPlan["tasks"][number];

/** One task's section of the tool result, for the orchestrator to integrate. */
const taskReport = (task: Task, settled: PromiseSettledResult<SwarmWorkerResult>) => {
  const head = `## ${task.id}: ${task.title}`;
  if (settled.status === "rejected" || settled.value.status === "error") {
    const reason = settled.status === "rejected"
      ? String((settled.reason as { message?: unknown })?.message ?? settled.reason)
      : settled.value.summary;
    return `${head} (failed)\n${reason}\nFinish it yourself; it owned ${task.ownedPaths.join(", ")}.`;
  }
  const { status, summary, writtenPaths, selfCheck } = settled.value;
  const files = writtenPaths.length ? writtenPaths.join(", ") : "none";
  const check = selfCheck ? `\nSelf-check (its files only, not the build): ${selfCheck}` : "";
  const finish = status === "unfinished" ? `\nFinish the rest yourself; it owned ${task.ownedPaths.join(", ")}.` : "";
  return `${head} (${status})\nFiles written: ${files}${check}\n${summary}${finish}`;
};

/**
 * Swarm mode's orchestrator tool: runs 2-4 tasks with disjoint owned paths as
 * parallel swarm-worker functions and returns their reports. Once per run; the
 * orchestrator then integrates and checks the build itself. A sub-orchestrator
 * gets it too (`parent`), for 2-3 workers inside its own paths (depth 2).
 */
export const createDelegateTasksTool = ({
  internalKey, projectId, messageId, ownerId, model, originalPrompt, parent, writtenPaths, maxDepth = MAX_SWARM_DEPTH,
  // Rebuilt on every replay: handlers re-run in order, so the first valid call sets it again.
  state = { delegated: false }, soloRefusal,
}: DelegateTasksToolOptions) => {
  const depth = parent?.depth ?? 0;
  const subOrchestrators = !parent && maxDepth >= MAX_SWARM_DEPTH;
  return createTool({
    name: "delegateTasks",
    description:
      "Run 2-4 tasks in parallel, each by a worker that writes only its owned paths. ownedPaths must be files or folders under src/ or public/ (e.g. src/pages/Home.tsx, src/components/gallery, public), disjoint between tasks. " +
      "Root config and the shared files (index.html, package.json, configs; Vite: src/App.tsx, src/main.tsx, src/index.css; Next.js: src/app/layout.tsx, src/app/globals.css, src/app/page.tsx, src/app/providers.tsx, src/middleware.ts) are yours: write them before delegating. Call it once, after writing the shared foundation. " +
      "Returns each task's report: done, unfinished or failed, the files it wrote, and its NEEDS: requests." +
      (subOrchestrators ? " A task with role \"sub-orchestrator\" (at most 2) splits its own paths among up to 3 workers." : ""),
    parameters: swarmPlanSchema,
    handler: async (input, { step }) => {
      if (state.delegated) return "Error: already delegated, integrate now.";
      if (depth >= MAX_SWARM_DEPTH) return "Error: Workers cannot delegate; build it yourself.";
      // The board shows the reason from this call's recorded step (`swarmSoloReason`).
      if (input.solo && !input.tasks?.length) {
        if (soloRefusal) return `Error: Swarm mode: this request is split among workers (${soloRefusal}). Delegate 2-4 tasks.`;
        state.delegated = true;
        return "Building solo: build it yourself, then run checkBuild.";
      }
      const plan = validatePlan(input, { withinPaths: parent?.ownedPaths, maxDepth });
      if (typeof plan === "string") return plan;
      if (!step) throw new Error("delegateTasks runs only inside an Inngest function");

      // Owned paths are canonical (no trailing "/"): create each one's parent folders up front, so two
      // workers never race to create the same folder. A user lock is refused here, before any task exists.
      const lockError = await step.run("ensure-swarm-folders", async () => {
        const index = indexProjectFiles(await getProjectFiles(internalKey, projectId));
        const paths = plan.tasks.flatMap((task) => task.ownedPaths);
        const locked = paths.map((path) => lockedPathError(index, path, true)).find(Boolean);
        if (locked) return locked;
        const ensureFolder = folderEnsurer(internalKey, projectId, folderPaths(index));
        for (const path of paths) await ensureFolder(splitPath(path).dir);
        return null;
      });
      if (lockError) return `Error: ${lockError} Re-plan without it.`;
      state.delegated = true;

      // Only the models' ids and labels leave these steps, never a model or its key.
      const workerModel = await step.run("resolve-worker-model", async () =>
        (await resolveWorkerModel({ internalKey, projectId, choice: model })).codingModel);
      const subModel = plan.tasks.some((task) => task.role === "sub-orchestrator")
        ? await step.run("resolve-suborch-model", async () =>
          (await resolveWorkerModel({ internalKey, projectId, choice: model, role: "sub-orchestrator" })).codingModel)
        : workerModel;
      const agentTaskIds = await step.run("create-agent-tasks", async () => {
        try {
          return await convex.mutation(api.agentTasks.createTasks, {
            internalKey,
            messageId,
            projectId,
            byok: Boolean(model.keyId),
            tasks: plan.tasks.map((task) => {
              const role = task.role ?? "worker";
              const { id: modelId, label } = role === "sub-orchestrator" ? subModel : workerModel;
              return {
                taskId: parent ? `${parent.taskId}/${task.id}` : task.id,
                role,
                title: task.title,
                brief: task.brief,
                ownedPaths: task.ownedPaths,
                modelId,
                model: label,
                ...(parent ? { parentTaskId: parent.taskId } : {}),
              };
            }),
          });
        } catch (error) {
          const code = getAppError(error)?.code;
          if (code === "LIMIT_EXCEEDED" || code === "CONFLICT") return code;
          throw error;
        }
      });
      if (agentTaskIds === "LIMIT_EXCEEDED") return `Error: The swarm already runs ${MAX_SWARM_AGENTS} agents; build these tasks yourself.`;
      // One platform swarm per owner at a time (ADR 0013).
      if (agentTaskIds === "CONFLICT") return "Error: another swarm is already running for this account; build this one yourself.";

      const planOverview = `## Swarm plan\n${plan.tasks
        .map((task) => `- ${task.id} (${task.title}): ${task.ownedPaths.join(", ")}`)
        .join("\n")}`;
      // Beside the workers (a parallel step), for their optional self-checks; null while that is off.
      const foundation = parent ? Promise.resolve(null)
        : step.run("swarm-foundation", () => seedSwarmSnapshot({ internalKey, projectId, messageId })).catch(() => null);
      const settled = await Promise.allSettled(
        plan.tasks.map((task, i) =>
          step.invoke(`run-task-${task.id}`, {
            function: swarmWorker,
            data: {
              parentMessageId: messageId,
              agentTaskId: agentTaskIds[i],
              ...(parent ? { parentAgentTaskId: parent.agentTaskId } : {}),
              projectId,
              ownerId,
              model,
              planOverview,
              siblingOwnedPaths: plan.tasks.filter((other) => other.id !== task.id).flatMap((other) => other.ownedPaths),
              ...(originalPrompt ? { originalPrompt: capOriginalPrompt(originalPrompt) } : {}),
              depth: depth + 1,
            } satisfies SwarmWorkerEvent,
            timeout: parent ? CHILD_WORKER_TIMEOUT_MS : task.role === "sub-orchestrator" ? SUBORCH_TIMEOUT_MS : WORKER_TIMEOUT_MS,
          }) as Promise<SwarmWorkerResult>,
        ),
      );
      for (const result of settled) if (result.status === "fulfilled") writtenPaths?.push(...result.value.writtenPaths);

      // A timed-out worker keeps running: stop it so it can't write after the integration build.
      const failed = agentTaskIds.filter((_, i) => settled[i].status === "rejected");
      if (failed.length) {
        await step.run("stop-failed-tasks", async () => {
          await inngest.send(failed.map((agentTaskId) => ({ name: "agent-task/cancel", data: { agentTaskId } })));
          // A cancelled worker skips its onFailure, so its row is closed here.
          await Promise.all(failed.map((agentTaskId) => convex.mutation(api.agentTasks.finishTask, {
            internalKey, agentTaskId, status: "error", error: "The worker failed or timed out.",
          })));
        });
      }

      const snapshotId = await foundation;
      if (snapshotId) await step.run("swarm-sandbox-cleanup", () => cleanupSwarmSandboxes({ messageId, snapshotId }));

      const reports = [
        ...plan.tasks.map((task, i) => taskReport(task, settled[i])),
        parent
          ? "Integrate now: apply the NEEDS: requests inside your owned paths, finish failed or unfinished tasks, and pass the rest on in your own NEEDS:."
          : "Integrate now: apply every NEEDS: request, finish failed or unfinished tasks, then run checkBuild.",
      ].join("\n\n");
      // An error result is not a write, so a swarm that wrote nothing can't complete a first build (#338).
      // shortcut: a timed-out worker's partial writes are unknown here; the integrator rewrites its task.
      const wrote = settled.some((result) => result.status === "fulfilled" && result.value.writtenPaths.length > 0);
      return wrote ? reports : `Error: No worker wrote any files; build these tasks yourself.\n\n${reports}`;
    },
  });
};
