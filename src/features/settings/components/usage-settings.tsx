"use client";

import Link from "next/link";
import { KeyRoundIcon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { useAiPreferences } from "@/features/ai-providers/hooks/use-ai-providers";
import { useCreditUsage } from "@/features/billing/hooks/use-credit-usage";
import { formatCredits } from "@/features/billing/plans";
import { type Allowance, formatResetTime } from "@/features/billing/usage";

import { AI_PROVIDERS_SETTINGS_URL } from "../nav";

const AllowanceRow = ({ label, allowance, resetsAt }: { label: string; allowance: Allowance; resetsAt: number }) => (
  <div className="space-y-2">
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
      <span className="font-medium">{label}</span>
      <span className="tabular-nums text-muted-foreground">
        <span className="text-foreground">{formatCredits(allowance.left)}</span> of{" "}
        {formatCredits(allowance.total)} credits left
      </span>
    </div>
    <Progress value={allowance.percentLeft} aria-label={`${label}: credits left`} />
    <p className="text-xs text-muted-foreground">
      Resets <time dateTime={new Date(resetsAt).toISOString()}>{formatResetTime(resetsAt)}</time>
    </p>
  </div>
);

export const UsageSettings = () => {
  const usage = useCreditUsage();
  const preferences = useAiPreferences();

  return (
    <div className="space-y-6">
      {preferences?.defaultKeyId && (
        <Alert>
          <KeyRoundIcon />
          <AlertDescription>
            Your default model runs on your own provider key. Runs on your own key don&apos;t use credits.
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Credits left</CardTitle>
          <CardDescription>
            {usage ? `${usage.plan.name} plan. ` : ""}Runs on Codenaya&apos;s models use credits; 1 credit is
            $0.01 of AI usage. Runs on{" "}
            <Link href={AI_PROVIDERS_SETTINGS_URL} className="underline underline-offset-2 hover:text-foreground">
              your own key
            </Link>{" "}
            don&apos;t.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {usage === undefined ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Spinner className="size-4" />
              Loading usage...
            </div>
          ) : (
            <>
              {usage.day && <AllowanceRow label="Today" allowance={usage.day} resetsAt={usage.dayResetsAt} />}
              <AllowanceRow label="This month" allowance={usage.month} resetsAt={usage.monthResetsAt} />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
