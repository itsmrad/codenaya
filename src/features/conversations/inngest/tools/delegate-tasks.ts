import { createTool } from "@inngest/agent-kit";

import { resolveWorkerModel } from "@/features/ai-providers/server/resolve-run-model";
import { convex } from "@/lib/convex-client";
import { getAppError } from "@/lib/convex-error";

import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import type { AgentModelChoice } from "../../agent-models";
import { MAX_SWARM_AGENTS, MAX_SWARM_DEPTH, type SwarmPlan, swarmPlanSchema, validatePlan } from "../../swarm";
import { type SwarmWorkerEvent, type SwarmWorkerResult, swarmWorker } from "../swarm-worker";
import { folderEnsurer, folderPaths, getProjectFiles, indexProjectFiles, splitPath } from "./paths";

interface DelegateTasksToolOptions {
  internalKey: string;
  projectId: Id<"projects">;
  messageId: Id<"messages">;
  ownerId: string;
  model: AgentModelChoice;
  /** A sub-orchestrator's call (depth 1): its task, whose owned paths its workers split. */
  parent?: { taskId: string; ownedPaths: string[]; depth: number };
  /** Collects the paths its workers wrote, for the sub-orchestrator's own report. */
  writtenPaths?: string[];
  /** How deep this run's swarm may go (see `validatePlan`); Convex enforces it too. */
  maxDepth?: number;
}

/** How long a task may queue and run before it counts as failed: a sub-orchestrator waits on its workers too. */
const WORKER_TIMEOUT = "12m";
const SUBORCH_TIMEOUT = "25m";
const CHILD_TIMEOUT = "10m";

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
  const { status, summary, writtenPaths } = settled.value;
  const files = writtenPaths.length ? writtenPaths.join(", ") : "none";
  const finish = status === "unfinished" ? `\nFinish the rest yourself; it owned ${task.ownedPaths.join(", ")}.` : "";
  return `${head} (${status})\nFiles written: ${files}\n${summary}${finish}`;
};

/**
 * Swarm mode's orchestrator tool: runs 2-4 tasks with disjoint owned paths as
 * parallel swarm-worker functions and returns their reports. Once per run; the
 * orchestrator then integrates and checks the build itself. A sub-orchestrator
 * gets it too (`parent`), for 2-3 workers inside its own paths (depth 2).
 */
export const createDelegateTasksTool = ({
  internalKey, projectId, messageId, ownerId, model, parent, writtenPaths, maxDepth = MAX_SWARM_DEPTH,
}: DelegateTasksToolOptions) => {
  const depth = parent?.depth ?? 0;
  const subOrchestrators = !parent && maxDepth >= MAX_SWARM_DEPTH;
  // Rebuilt on every replay: handlers re-run in order, so the first valid call sets it again.
  let delegated = false;
  return createTool({
    name: "delegateTasks",
    description:
      "Run 2-4 tasks in parallel, each by a worker that writes only its owned paths (files, or folders ending in \"/\", under src/, disjoint between tasks). " +
      "Shared files (package.json, src/App.tsx, src/main.tsx, src/index.css, configs) stay yours. Call it once, after writing the shared foundation. " +
      "Returns each task's report: done, unfinished or failed, the files it wrote, and its NEEDS: requests." +
      (subOrchestrators ? " A task with role \"sub-orchestrator\" (at most 2) splits its own paths among up to 3 workers." : ""),
    parameters: swarmPlanSchema,
    handler: async (input, { step }) => {
      if (delegated) return "Error: already delegated, integrate now.";
      if (depth >= MAX_SWARM_DEPTH) return "Error: Workers cannot delegate; build it yourself.";
      const plan = validatePlan(input, { withinPaths: parent?.ownedPaths, maxDepth });
      if (typeof plan === "string") return plan;
      if (!step) throw new Error("delegateTasks runs only inside an Inngest function");
      delegated = true;

      const agentTaskIds = await step.run("create-agent-tasks", async () => {
        // Only the models' ids and labels leave this step, never a model or its key.
        const worker = (await resolveWorkerModel({ internalKey, projectId, choice: model })).codingModel;
        const sub = plan.tasks.some((task) => task.role === "sub-orchestrator")
          ? (await resolveWorkerModel({ internalKey, projectId, choice: model, role: "sub-orchestrator" })).codingModel
          : worker;
        try {
          return await convex.mutation(api.agentTasks.createTasks, {
            internalKey,
            messageId,
            projectId,
            byok: Boolean(model.keyId),
            tasks: plan.tasks.map((task) => {
              const role = task.role ?? "worker";
              const { id: modelId, label } = role === "sub-orchestrator" ? sub : worker;
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

      // Created up front, so two workers never race to create the same folder. Owned paths are
      // canonical (no trailing "/"), so each one's parent: the path itself has a single owner.
      await step.run("ensure-swarm-folders", async () => {
        const index = indexProjectFiles(await getProjectFiles(internalKey, projectId));
        const ensureFolder = folderEnsurer(internalKey, projectId, folderPaths(index));
        for (const path of plan.tasks.flatMap((task) => task.ownedPaths)) {
          await ensureFolder(splitPath(path).dir);
        }
      });

      const planOverview = `## Swarm plan\n${plan.tasks
        .map((task) => `- ${task.id} (${task.title}): ${task.ownedPaths.join(", ")}`)
        .join("\n")}`;
      const settled = await Promise.allSettled(
        plan.tasks.map((task, i) =>
          step.invoke(`run-task-${task.id}`, {
            function: swarmWorker,
            data: {
              parentMessageId: messageId,
              agentTaskId: agentTaskIds[i],
              projectId,
              ownerId,
              model,
              planOverview,
              depth: depth + 1,
            } satisfies SwarmWorkerEvent,
            timeout: parent ? CHILD_TIMEOUT : task.role === "sub-orchestrator" ? SUBORCH_TIMEOUT : WORKER_TIMEOUT,
          }) as Promise<SwarmWorkerResult>,
        ),
      );
      for (const result of settled) if (result.status === "fulfilled") writtenPaths?.push(...result.value.writtenPaths);
      return [
        ...plan.tasks.map((task, i) => taskReport(task, settled[i])),
        parent
          ? "Integrate now: apply the NEEDS: requests inside your owned paths, finish failed or unfinished tasks, and pass the rest on in your own NEEDS:."
          : "Integrate now: apply every NEEDS: request, finish failed or unfinished tasks, then run checkBuild.",
      ].join("\n\n");
    },
  });
};
