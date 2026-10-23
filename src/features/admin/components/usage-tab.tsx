"use client";

import { useQuery } from "convex/react";
import { CircleAlertIcon, InfoIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { UNPRICED_FALLBACK_PRICE, monthKey, monthName } from "@/features/ai-usage/limits";

import { api } from "../../../../convex/_generated/api";

import type { PlatformProviderId } from "../platform-models";
import { PlanLimitsCard } from "./plan-limits-card";
import { TopSpendersCard } from "./top-spenders-card";

const FALLBACK_RATE = `$${UNPRICED_FALLBACK_PRICE.inputUsdPerMTok}/$${UNPRICED_FALLBACK_PRICE.outputUsdPerMTok}`;

/** Per-plan monthly caps on Codenaya AI, and who is using it this month. */
export const UsageTab = ({ fallbackProvider }: { fallbackProvider: PlatformProviderId }) => {
  const limits = useQuery(api.planLimits.listPlanLimits, {});
  const active = useQuery(api.platformModels.getActive, { fallbackProvider });
  const month = monthKey();
  const monthLabel = monthName(month, true);

  return (
    <>
      {active && !active.config && (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>Models not configured: usage isn&apos;t priced</AlertTitle>
          <AlertDescription>
            The active provider has no saved prices, so its usage is charged at a fallback of {FALLBACK_RATE}{" "}
            per 1M tokens and users hit their caps early. Save its models with prices in the Models tab.
          </AlertDescription>
        </Alert>
      )}

      <Alert>
        <InfoIcon aria-hidden="true" />
        <AlertTitle className="line-clamp-none">Whichever cap is reached first blocks the user until next month</AlertTitle>
        <AlertDescription>
          Only Codenaya AI counts; usage on a user&apos;s own key doesn&apos;t. A cap of 0 turns Codenaya AI off for
          the plan. Everyone is on Free until billing ships (#105).
        </AlertDescription>
      </Alert>

      {limits === undefined ? (
        <div className="grid gap-6 lg:grid-cols-2" aria-label="Loading plan limits">
          <Skeleton className="h-80 w-full" />
          <Skeleton className="h-80 w-full" />
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {limits.map((row) => (
            <PlanLimitsCard key={row.planId} row={row} />
          ))}
        </div>
      )}

      <TopSpendersCard month={month} monthLabel={monthLabel} />
    </>
  );
};
