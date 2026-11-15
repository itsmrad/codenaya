"use client";

import { useRunCredits } from "@/features/billing/hooks/use-run-credits";
import { formatCredits } from "@/features/billing/plans";
import { runCostLabel } from "@/features/billing/usage";

import type { Id } from "../../../../convex/_generated/dataModel";

/** A finished run's cost, e.g. "≈ $0.04"; nothing for a run that used no credits (#526). */
export const RunCost = ({ messageId }: { messageId: Id<"messages"> }) => {
  const credits = useRunCredits(messageId);
  const label = runCostLabel(credits);
  if (!label || !credits) return null;
  return (
    <span
      className="shrink-0 text-muted-foreground"
      // The dollars, with the credits they came from: 1 credit is $0.01.
      title={`${label} · ${formatCredits(credits)} ${credits === 1 ? "credit" : "credits"}`}
    >
      · {label}
    </span>
  );
};
