/**
 * Dashboard card status (#318): how a project's last agent run went, from the
 * owner's `run_started` / `run_finished` activation events, so the list costs
 * the same however many cards it has.
 */
export type LastRunStatus = "running" | "failed" | "done";

/** What a dashboard card shows; both fields are absent on older backends. */
export interface ProjectCardStatus {
  published?: boolean;
  lastRun?: LastRunStatus;
}

interface RunEvent {
  projectId?: string;
  at: number;
}

interface RunFinishedEvent extends RunEvent {
  outcome: "ok" | "error" | "cancelled";
}

/** Each project's newest event; events may come in any order. */
const newestByProject = <E extends RunEvent>(events: E[]) => {
  const newest = new Map<string, E>();
  for (const event of events) {
    if (!event.projectId) continue;
    const seen = newest.get(event.projectId);
    if (!seen || event.at > seen.at) newest.set(event.projectId, event);
  }
  return newest;
};

/**
 * A run that started after the last one finished is still running. A
 * cancelled run gets no status: the user stopped it.
 */
export const lastRunStatuses = (
  started: RunEvent[],
  finished: RunFinishedEvent[],
): Map<string, LastRunStatus> => {
  const lastFinished = newestByProject(finished);
  const statuses = new Map<string, LastRunStatus>();
  for (const [projectId, start] of newestByProject(started)) {
    const end = lastFinished.get(projectId);
    if (!end || end.at < start.at) statuses.set(projectId, "running");
    else if (end.outcome === "error") statuses.set(projectId, "failed");
    else if (end.outcome === "ok") statuses.set(projectId, "done");
  }
  return statuses;
};
