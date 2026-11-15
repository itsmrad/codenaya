import type { Doc } from "../../../convex/_generated/dataModel";
import type { AgentStep } from "./agent-steps";

/** The agentTasks fields the board reads. */
export type SwarmTask = Pick<
  Doc<"agentTasks">,
  "taskId" | "parentTaskId" | "role" | "title" | "model" | "status" | "steps" | "summary" | "error" | "startedAt" | "endedAt" | "updatedAt" | "selfCheck"
>;

/** Depth-2 children follow their lead; incomplete subscriptions never hide orphan rows. */
export const groupSwarmTasks = (tasks: SwarmTask[]) => {
  const leads = new Set(tasks.filter((task) => task.role === "sub-orchestrator").map((task) => task.taskId));
  const isChild = (task: SwarmTask) => task.role === "worker" && task.parentTaskId !== undefined && leads.has(task.parentTaskId);
  return tasks.filter((task) => !isChild(task)).map((task) => ({
    task,
    children: tasks.filter((child) => isChild(child) && child.parentTaskId === task.taskId),
  }));
};

export const swarmSelfCheckStatus = (value: string | undefined) => {
  if (value === "scoped-ok") return "ok";
  if (value?.startsWith("scoped-failed")) return "failed";
  if (value?.startsWith("skipped")) return "skipped";
  if (value === "running") return "running";
};

export type SwarmParentStatus = NonNullable<Doc<"messages">["status"]>;

export const swarmTaskStatus = (status: SwarmTask["status"] | "cancelled", parent: SwarmParentStatus) =>
  parent !== "processing" && (status === "running" || status === "queued")
    ? "cancelled"
    : status;

/** A clock rather than prose keeps the board header compact. */
export const swarmElapsed = (startedAt: number, endedAt: number) => {
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** The step a solo swarm run records with the classifier's reason ("Building solo: <reason>"). */
export const SWARM_SOLO_STEP_ID = "swarm-solo";

/**
 * Why a finished swarm ran no workers: the classifier's solo reason, the refusal its
 * last delegateTasks call got, that call's own solo reason, or neither.
 * A live run needs an explicit solo step before it can be labelled solo.
 */
export const swarmSoloReason = (steps: AgentStep[], live = false) => {
  const solo = steps.find((step) => step.id === SWARM_SOLO_STEP_ID)?.text?.replace(/^Building solo:\s*/, "");
  if (solo || live) return solo;
  const call = steps.findLast((step) => step.tool === "delegateTasks");
  return call?.error?.replace(/^error:\s*/i, "") || call?.targets?.[0] || "the orchestrator did not delegate";
};

/** With no tasks, show the recorded solo reason or the live foundation/planning phase. */
export const swarmHeader = (tasks: SwarmTask[], startedAt: number, endedAt: number, solo?: string, steps: AgentStep[] = []) => {
  if (solo && tasks.length === 0) return `Swarm · Built solo: ${solo} · ${swarmElapsed(startedAt, endedAt)}`;
  if (tasks.length === 0) {
    const completed = steps.filter((step) => step.kind === "tool" && step.status !== "running").length;
    // The foundation budget (FOUNDATION_MAX_STEPS) counts model calls, in swarm-run's forceDelegation. One reply can write
    // several files, so tool rows are shown as plain progress and never as n/budget.
    const planning = steps.some((step) => step.tool === "delegateTasks");
    return `Swarm · ${planning ? "Planning tasks…" : `Setting up shared files · ${completed} ${completed === 1 ? "step" : "steps"} done`} · ${swarmElapsed(startedAt, endedAt)}`;
  }
  const workers = tasks.filter((task) => task.role === "worker");
  const leads = tasks.length - workers.length;
  const done = workers.filter((task) => task.status === "done").length;
  const leadLabel = leads > 0 ? `${leads} ${leads === 1 ? "lead" : "leads"} · ` : "";
  return `Swarm · ${leadLabel}${workers.length} ${workers.length === 1 ? "worker" : "workers"} · ${swarmElapsed(startedAt, endedAt)} · ${done} done`;
};
