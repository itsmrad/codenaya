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

/**
 * Replays each project's run events in time order: a run is still going while
 * more runs have started than finished, so an overlapping run that ends first
 * doesn't read as Done. Otherwise the last finish says how it went; a
 * cancelled run gets no status, since the user stopped it.
 */
export const lastRunStatuses = (
  started: RunEvent[],
  finished: RunFinishedEvent[],
): Map<string, LastRunStatus> => {
  const events = new Map<string, (RunEvent | RunFinishedEvent)[]>();
  for (const event of started) {
    if (event.projectId) events.set(event.projectId, [...(events.get(event.projectId) ?? []), event]);
  }
  // A finish whose start is older than the events read says nothing on its own.
  for (const event of finished) {
    if (event.projectId && events.has(event.projectId)) events.get(event.projectId)!.push(event);
  }

  const statuses = new Map<string, LastRunStatus>();
  for (const [projectId, projectEvents] of events) {
    // On a tie the start comes first: a run can end in the millisecond it began.
    projectEvents.sort((a, b) => a.at - b.at || Number("outcome" in a) - Number("outcome" in b));
    let open = 0;
    let outcome: RunFinishedEvent["outcome"] | undefined;
    for (const event of projectEvents) {
      if ("outcome" in event) {
        open = Math.max(0, open - 1);
        outcome = event.outcome;
      } else {
        open += 1;
      }
    }
    if (open > 0) statuses.set(projectId, "running");
    else if (outcome === "error") statuses.set(projectId, "failed");
    else if (outcome === "ok") statuses.set(projectId, "done");
  }
  return statuses;
};
