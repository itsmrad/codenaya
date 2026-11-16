"use client";

import Link from "next/link";

import { AUTO_MODEL_ID, autoMinRunCredits } from "@/features/ai-providers/auto-route";
import { usePlatformModelsOrCatalog } from "@/features/ai-providers/hooks/use-ai-providers";
import { resolveCatalogModel } from "@/features/ai-providers/platform";
import { minRunCredits } from "@/features/billing/credits";
import { useCreditUsage } from "@/features/billing/hooks/use-credit-usage";
import { formatCredits } from "@/features/billing/plans";
import { USAGE_SETTINGS_URL } from "@/features/settings/nav";

/**
 * One line above or below the composer when under 20% of the day or month is
 * left (#526), or when the credits left can't start the picked model (#643).
 */
export const LowCreditsNotice = ({ modelId }: { modelId?: string }) => {
  const usage = useCreditUsage();
  const platform = usePlatformModelsOrCatalog();
  if (!usage) return null;
  const { day, month } = usage;
  const today = day !== null && day.left <= month.left;
  const left = today ? day.left : month.left;
  const model =
    modelId && modelId !== AUTO_MODEL_ID
      ? resolveCatalogModel(platform, modelId)
      : undefined;
  const needed = modelId === AUTO_MODEL_ID
    ? autoMinRunCredits(platform.models)
    : minRunCredits(model?.pricing);
  const shortForModel = left < needed;
  if (!usage.isLow && !shortForModel) return null;

  return (
    <p className="mt-2 px-1 text-xs text-muted-foreground">
      {left === 0 ? "No" : `Only ${formatCredits(left)}`} {left === 1 ? "credit" : "credits"} left{" "}
      {today ? "today" : "this month"}
      {left > 0 && shortForModel ? ` (~${formatCredits(needed)} needed to start)` : ""}.{" "}
      <Link href={USAGE_SETTINGS_URL} className="text-foreground underline underline-offset-2">
        See usage
      </Link>
    </p>
  );
};
