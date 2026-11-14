import type { Checkpoint } from "@/features/conversations/hooks/use-checkpoints";

/** Lists are newest first; delete/restore snapshots must not hide the latest run. */
export const comparisonBaseline = (checkpoints: Checkpoint[], selected?: string) =>
  checkpoints.find((checkpoint) => checkpoint._id === selected) ??
  checkpoints.find((checkpoint) => checkpoint.messageId) ?? checkpoints[0];
