import type { Doc } from "../../../convex/_generated/dataModel";
import type { AgentStep } from "./agent-steps";

/** The agentTasks fields the board reads. */
export type SwarmTask = Pick<
  Doc<"agentTasks">,
  "taskId" | "role" | "title" | "model" | "status" | "steps" | "summary" | "error" | "startedAt" | "endedAt" | "updatedAt"
>;

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

/** Why a finished swarm ran no workers: its solo reason, the refusal its delegateTasks call got, or neither. */
export const swarmSoloReason = (steps: AgentStep[]) => {
  const call = steps.findLast((step) => step.tool === "delegateTasks");
  return call?.error?.replace(/^error:\s*/i, "") || call?.targets?.[0] || "the orchestrator did not delegate";
};

/** `solo`: a finished run's `swarmSoloReason`, shown in place of the counts when it ran no workers. */
export const swarmHeader = (tasks: SwarmTask[], startedAt: number, endedAt: number, solo?: string) => {
  if (solo && tasks.length === 0) return `Swarm · Built solo: ${solo} · ${swarmElapsed(startedAt, endedAt)}`;
  const workers = tasks.filter((task) => task.role === "worker").length;
  const done = tasks.filter((task) => task.status === "done").length;
  return `Swarm · ${workers} ${workers === 1 ? "worker" : "workers"} · ${swarmElapsed(startedAt, endedAt)} · ${done} done`;
};
