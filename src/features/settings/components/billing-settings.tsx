"use client";

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { type CheckoutSku, startCheckout } from "@/features/billing/checkout";
import { formatCredits, TOP_UP } from "@/features/billing/plans";
import { useNow } from "@/hooks/use-now";

import { api } from "../../../../convex/_generated/api";

/** How often the summary is re-read on a fresh clock, so a period that ends shows as ended. */
const CLOCK_MS = 60_000;

/** The caller's billing summary on a minute-coarse clock, so the query is re-read once a minute. */
const useBillingSummary = (active = true) => {
  const now = useNow(active, CLOCK_MS);
  return useQuery(api.billingSummary.mine, active ? { now: now - (now % CLOCK_MS) } : "skip");
};

const formatDate = (at: number) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(at);

type Summary = FunctionReturnType<typeof api.billingSummary.mine>;

const planLabel = (summary: Summary | undefined) => {
  if (summary === undefined) return "Loading...";
  if (summary.plan === "pro" && summary.paidThroughMs !== null) return `Pro — paid through ${formatDate(summary.paidThroughMs)}`;
  return "Free";
};

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-baseline justify-between gap-4 text-sm">
    <span className="text-muted-foreground">{label}</span>
    <span className="tabular-nums font-medium">{value}</span>
  </div>
);

const BillingSummaryCard = ({ summary }: { summary: Summary | undefined }) => (
  <Card>
    <CardHeader>
      <CardTitle>Current plan</CardTitle>
      <CardDescription>{planLabel(summary)}</CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      {summary === undefined ? (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Loading credits...
        </div>
      ) : (
        <>
          <Row label="Paid credits" value={formatCredits(summary.paidCreditsRemaining)} />
          {summary.freeRemaining !== null && (
            <Row label="Free credits this month" value={formatCredits(summary.freeRemaining)} />
          )}
          {summary.debt > 0 && <Row label="Credits owed" value={formatCredits(summary.debt)} />}
        </>
      )}
    </CardContent>
  </Card>
);

/** The caller's plan and credits, live: fulfillment updates it once Dodo confirms a payment. */
export const BillingSummary = () => <BillingSummaryCard summary={useBillingSummary()} />;

export const BillingSettings = ({ enabled, topUpsEnabled }: { enabled: boolean; topUpsEnabled: boolean }) => {
  const summary = useBillingSummary(enabled);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!enabled) {
    return (
      <Alert>
        <AlertDescription>Billing isn&apos;t enabled yet.</AlertDescription>
      </Alert>
    );
  }

  const checkout = async (sku: CheckoutSku) => {
    setPending(true);
    setError(null);
    const result = await startCheckout(sku);
    if ("url" in result) {
      // Stays pending while the browser leaves for Dodo.
      window.location.assign(result.url);
      return;
    }
    setError(result.error);
    setPending(false);
  };

  return (
    <div className="space-y-6">
      <BillingSummaryCard summary={summary} />
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap gap-3">
        {summary !== undefined && summary.plan !== "pro" && (
          <Button disabled={pending} onClick={() => void checkout("pro_monthly")}>
            Subscribe to Pro
          </Button>
        )}
        {/* Top-ups are Pro-only: checkout refuses Free with `not_pro`. */}
        {topUpsEnabled && summary?.plan === "pro" && (
          <Button variant="outline" disabled={pending} onClick={() => void checkout("top_up")}>
            Buy {formatCredits(TOP_UP.credits)} credits
          </Button>
        )}
      </div>
    </div>
  );
};
