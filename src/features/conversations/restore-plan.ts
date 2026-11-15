/** A file's status in the live-vs-checkpoint comparison (`checkpoints.listChanges`, project scope). */
interface Change {
  path: string;
  status: "added" | "modified" | "deleted";
}

/**
 * What restoring a checkpoint does to each differing file. The comparison runs
 * from the checkpoint to the live files, so a file "added" since then is
 * removed by the restore and one "deleted" since then comes back (#363).
 */
export function restorePlan(changes: Change[]) {
  const paths = (status: Change["status"]) =>
    changes.filter((change) => change.status === status).map((change) => change.path);
  return { removed: paths("added"), changed: paths("modified"), recreated: paths("deleted") };
}
