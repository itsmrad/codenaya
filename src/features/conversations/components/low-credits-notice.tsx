"use client";

import Link from "next/link";

import { AUTO_MODEL_ID } from "@/features/ai-providers/auto-route";
import { type RunTaskKind, estimateRunCredits } from "@/features/billing/credits";
import { useCreditUsage } from "@/features/billing/hooks/use-credit-usage";
import { formatCredits } from "@/features/billing/plans";
import { USAGE_SETTINGS_URL } from "@/features/settings/nav";

/**
 * One line above or below the composer when under 20% of credits remain (#526)
 * or remaining credits are below the selected model's estimated run cost (#643).
 */
export const LowCreditsNotice = ({
  modelId,
  task = "build",
}: {
  modelId?: string;
  task?: RunTaskKind;
} = {}) => {
  const usage = useCreditUsage();
  if (!usage) return null;
  const { day, month } = usage;
  const today = day !== null && day.left <= month.left;
  const left = today ? day.left : month.left;
  const needed = modelId && modelId !== AUTO_MODEL_ID ? estimateRunCredits(modelId, task) : 1;
  const shortForModel = left < needed;
  if (!usage.isLow && !shortForModel) return null;

  return (
    <p className="mt-2 px-1 text-xs text-muted-foreground">
      {left === 0 ? "No" : `Only ${formatCredits(left)}`} {left === 1 ? "credit" : "credits"} left{" "}
      {today ? "today" : "this month"}
      {left > 0 && shortForModel ? ` (~${formatCredits(needed)} needed for this run)` : ""}.{" "}
      <Link href={USAGE_SETTINGS_URL} className="text-foreground underline underline-offset-2">
        See usage
      </Link>
    </p>
  );
};
