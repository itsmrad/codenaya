"use client";

import { useRunCredits } from "@/features/billing/hooks/use-run-credits";
import { runCostLabel } from "@/features/billing/usage";

import type { Id } from "../../../../convex/_generated/dataModel";

/** A finished run's cost, e.g. "≈ $0.04"; nothing for a run that used no credits (#526). */
export const RunCost = ({ messageId }: { messageId: Id<"messages"> }) => {
  const label = runCostLabel(useRunCredits(messageId));
  if (!label) return null;
  return (
    <span className="shrink-0 text-muted-foreground" title="Credits this run used">
      · {label}
    </span>
  );
};
