import { createTool } from "@inngest/agent-kit";

import { resolveWorkerModel } from "@/features/ai-providers/server/resolve-run-model";
import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import type { AgentModelChoice } from "../../agent-models";
import { type SwarmPlan, swarmPlanSchema, validatePlan } from "../../swarm";
import { cleanupSwarmSandboxes, seedSwarmSnapshot } from "../../swarm-sandbox";
import { type SwarmWorkerEvent, type SwarmWorkerResult, swarmWorker } from "../swarm-worker";
import { folderEnsurer, folderPaths, getProjectFiles, indexProjectFiles, splitPath } from "./paths";

interface DelegateTasksToolOptions {
  internalKey: string;
  projectId: Id<"projects">;
  messageId: Id<"messages">;
  ownerId: string;
  model: AgentModelChoice;
}

/** How long a worker may queue and run before it counts as failed. */
const WORKER_TIMEOUT = "12m";

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
 * orchestrator then integrates and checks the build itself.
 */
export const createDelegateTasksTool = ({ internalKey, projectId, messageId, ownerId, model }: DelegateTasksToolOptions) => {
  // Rebuilt on every replay: handlers re-run in order, so the first valid call sets it again.
  let delegated = false;
  return createTool({
    name: "delegateTasks",
    description:
      "Run 2-4 tasks in parallel, each by a worker that writes only its owned paths (files, or folders ending in \"/\", under src/, disjoint between tasks). " +
      "Shared files (package.json, src/App.tsx, src/main.tsx, src/index.css, configs) stay yours. Call it once, after writing the shared foundation. " +
      "Returns each task's report: done, unfinished or failed, the files it wrote, and its NEEDS: requests.",
    parameters: swarmPlanSchema,
    handler: async (input, { step }) => {
      if (delegated) return "Error: already delegated, integrate now.";
      const plan = validatePlan(input);
      if (typeof plan === "string") return plan;
      if (!step) throw new Error("delegateTasks runs only inside an Inngest function");
      delegated = true;

      const agentTaskIds = await step.run("create-agent-tasks", async () => {
        // Only the model's id and label leave this step, never the model or its key.
        const { codingModel } = await resolveWorkerModel({ internalKey, projectId, choice: model });
        return await convex.mutation(api.agentTasks.createTasks, {
          internalKey,
          messageId,
          projectId,
          tasks: plan.tasks.map((task) => ({
            taskId: task.id,
            role: "worker" as const,
            title: task.title,
            brief: task.brief,
            ownedPaths: task.ownedPaths,
            modelId: codingModel.id,
            model: codingModel.label,
          })),
        });
      });

      // Created up front, so two workers never race to create the same folder.
      await step.run("ensure-swarm-folders", async () => {
        const index = indexProjectFiles(await getProjectFiles(internalKey, projectId));
        const ensureFolder = folderEnsurer(internalKey, projectId, folderPaths(index));
        for (const path of plan.tasks.flatMap((task) => task.ownedPaths)) {
          await ensureFolder(path.endsWith("/") ? path.slice(0, -1) : splitPath(path).dir);
        }
      });

      const planOverview = `## Swarm plan\n${plan.tasks
        .map((task) => `- ${task.id} (${task.title}): ${task.ownedPaths.join(", ")}`)
        .join("\n")}`;
      // Beside the workers (a parallel step), for their optional self-checks; null while that is off.
      const foundation = step.run("swarm-foundation", () => seedSwarmSnapshot({ internalKey, projectId, messageId }))
        .catch(() => null);
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
            } satisfies SwarmWorkerEvent,
            timeout: WORKER_TIMEOUT,
          }) as Promise<SwarmWorkerResult>,
        ),
      );
      const snapshotId = await foundation;
      if (snapshotId) await step.run("swarm-sandbox-cleanup", () => cleanupSwarmSandboxes({ messageId, snapshotId }));
      return [
        ...plan.tasks.map((task, i) => taskReport(task, settled[i])),
        "Integrate now: apply every NEEDS: request, finish failed or unfinished tasks, then run checkBuild.",
      ].join("\n\n");
    },
  });
};
