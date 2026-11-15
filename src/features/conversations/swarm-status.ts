import type { Doc } from "../../../convex/_generated/dataModel";

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

export const swarmHeader = (tasks: SwarmTask[], startedAt: number, endedAt: number) => {
  const workers = tasks.filter((task) => task.role === "worker");
  const leads = tasks.length - workers.length;
  const done = workers.filter((task) => task.status === "done").length;
  const leadLabel = leads > 0 ? `${leads} ${leads === 1 ? "lead" : "leads"} · ` : "";
  return `Swarm · ${leadLabel}${workers.length} ${workers.length === 1 ? "worker" : "workers"} · ${swarmElapsed(startedAt, endedAt)} · ${done} done`;
};
