"use client";

import { useQuery } from "convex/react";

import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { PLANS } from "@/features/billing/plans";

import { api } from "../../../../convex/_generated/api";

import { capProgress, formatTokens, formatUsd, monthKey, resetDate } from "../limits";

/** The signed-in user's Codenaya AI usage this month against their plan's caps. */
export const UsageThisMonth = () => {
  const month = monthKey();
  const usage = useQuery(api.aiUsage.myUsage, { month });

  if (usage === undefined) return <Skeleton className="h-36 w-full" aria-label="Loading usage" />;

  const progress = capProgress(usage);
  const spend =
    usage.costLimitMicroUsd === undefined
      ? `${formatUsd(usage.costMicroUsd)} (no spend limit)`
      : `${formatUsd(usage.costMicroUsd)} of ${formatUsd(usage.costLimitMicroUsd)}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Codenaya AI this month</CardTitle>
        <CardDescription>
          Resets {resetDate(month)} · Usage on your own keys doesn&apos;t count.
        </CardDescription>
        <CardAction>
          <Badge variant="secondary">{PLANS[usage.planId].name} plan</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">
          Usage this month: <span className="font-medium tabular-nums">{spend}</span>
        </p>
        {usage.tokenLimit !== undefined && (
          <p className="text-sm text-muted-foreground">
            <span className="tabular-nums">
              {formatTokens(usage.tokens)} of {formatTokens(usage.tokenLimit)}
            </span>{" "}
            tokens
          </p>
        )}
        {progress !== null && <Progress value={progress} aria-label={`${progress}% of your monthly limit used`} />}
        {usage.exceeded && (
          <p className="text-sm text-destructive">
            Limit reached. Add your own API key below to keep building until it resets.
          </p>
        )}
      </CardContent>
    </Card>
  );
};
