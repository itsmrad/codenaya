import { format, isSameDay, subDays } from "date-fns";
import type { Checkpoint } from "@/features/conversations/hooks/use-checkpoints";

/** Lists are newest first; delete/restore snapshots must not hide the latest run. */
export const comparisonBaseline = (checkpoints: Checkpoint[], selected?: string) =>
  checkpoints.find((checkpoint) => checkpoint._id === selected) ??
  checkpoints.find((checkpoint) => checkpoint.messageId) ?? checkpoints[0];

export function checkpointMenuLabel(
  checkpoint: { messageId?: string; label?: string; _creationTime: number },
  now = new Date(),
) {
  const date = new Date(checkpoint._creationTime);
  const prefix = checkpoint.messageId ? "Before run" : "Snapshot";
  const label = checkpoint.label ? `${prefix} · ${checkpoint.label}` : prefix;
  const time = isSameDay(date, now) ? format(date, "h:mm a")
    : isSameDay(date, subDays(now, 1)) ? `Yesterday ${format(date, "h:mm a")}`
    : format(date, "MMM d, h:mm a");
  return { label, time, title: `${label} · ${date.toLocaleString()}` };
}
