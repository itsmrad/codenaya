"use client";

import { usePaginatedQuery } from "convex/react";
import { format, formatDistanceToNow } from "date-fns";
import { UsersIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { capProgress, formatTokens, formatUsd } from "@/features/ai-usage/limits";
import { PLANS } from "@/features/billing/plans";

import { api } from "../../../../convex/_generated/api";

const PAGE_SIZE = 20;

/** This month's platform AI usage per user, biggest spender first. */
export const TopSpendersCard = ({ month, monthLabel }: { month: string; monthLabel: string }) => {
  const { results, status, loadMore } = usePaginatedQuery(
    api.aiUsage.listTopSpenders,
    { month },
    { initialNumItems: PAGE_SIZE },
  );

  const renderBody = () => {
    if (status === "LoadingFirstPage") {
      return (
        <div className="space-y-2" aria-label="Loading usage">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      );
    }
    if (results.length === 0) {
      return (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UsersIcon />
            </EmptyMedia>
            <EmptyTitle>No usage yet</EmptyTitle>
            <EmptyDescription>Requests on the Codenaya key in {monthLabel} show up here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      );
    }
    return (
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead className="hidden w-20 sm:table-cell">Plan</TableHead>
            <TableHead className="w-24 text-right">Spent</TableHead>
            <TableHead className="hidden w-28 text-right md:table-cell">Tokens</TableHead>
            <TableHead className="hidden w-32 sm:table-cell">Of cap</TableHead>
            <TableHead className="hidden w-40 lg:table-cell">Last used</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {results.map((row) => {
            const progress = capProgress(row);
            return (
              <TableRow key={row.userId}>
                <TableCell className="min-w-0">
                  <p className="truncate text-sm font-medium">{row.name ?? row.email ?? row.userId}</p>
                  {row.name && row.email && <p className="truncate text-xs text-muted-foreground">{row.email}</p>}
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <Badge variant="outline">{PLANS[row.planId].name}</Badge>
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">{formatUsd(row.costMicroUsd)}</TableCell>
                <TableCell className="hidden text-right font-mono text-xs tabular-nums md:table-cell">
                  {formatTokens(row.tokens)}
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  {progress === null ? (
                    <span className="text-xs text-muted-foreground">No limit</span>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Progress value={progress} className="h-1.5" aria-label={`${progress}% of cap`} />
                      <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{progress}%</span>
                    </div>
                  )}
                </TableCell>
                <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                  <time dateTime={new Date(row.updatedAt).toISOString()} title={format(row.updatedAt, "PPpp")}>
                    {formatDistanceToNow(row.updatedAt, { addSuffix: true })}
                  </time>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Top spenders</CardTitle>
        <CardDescription>Codenaya AI usage in {monthLabel}, highest spend first. Own-key usage isn&apos;t counted.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {renderBody()}
        {(status === "CanLoadMore" || status === "LoadingMore") && (
          <div className="flex justify-center">
            <Button variant="outline" size="sm" onClick={() => loadMore(PAGE_SIZE)} disabled={status === "LoadingMore"}>
              {status === "LoadingMore" && <Spinner />}
              Load more
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
