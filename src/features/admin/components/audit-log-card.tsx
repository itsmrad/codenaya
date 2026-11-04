"use client";

import { Fragment } from "react";
import { usePaginatedQuery } from "convex/react";
import { format, formatDistanceToNow } from "date-fns";
import { ChevronDownIcon, HistoryIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { api } from "../../../../convex/_generated/api";
import type { Doc } from "../../../../convex/_generated/dataModel";

const PAGE_SIZE = 20;

// Rows before ADR 0010 have none of these.
type AuditDetails = Pick<Doc<"adminAuditLog">, "_id" | "changes" | "requestId" | "ip" | "userAgent">;

/** Before → after per field, and the request that made the change. */
const ChangeDetails = ({ entry }: { entry: AuditDetails }) => {
  if (!entry.changes?.length && !entry.requestId) return null;
  return (
    <Collapsible className="mt-1">
      <CollapsibleTrigger asChild>
        <Button variant="link" className="group h-auto gap-1 p-0 text-xs has-[>svg]:px-0">
          Details
          <ChevronDownIcon className="size-3 transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 space-y-2">
        {!!entry.changes?.length && (
          <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1">
            {entry.changes.map((change, i) => (
              <Fragment key={i}>
                <dt className="truncate font-mono text-muted-foreground" title={change.field}>
                  {change.field}
                </dt>
                <dd className="break-words">
                  <span className="text-muted-foreground line-through">{change.before ?? "—"}</span>
                  {" → "}
                  <span>{change.after ?? "—"}</span>
                </dd>
              </Fragment>
            ))}
          </dl>
        )}
        {entry.requestId && (
          <p className="break-all text-muted-foreground">
            Request <span className="font-mono">{entry.requestId}</span>
            {entry.ip && ` · ${entry.ip}`}
            {entry.userAgent && ` · ${entry.userAgent}`}
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
};

/** Every admin change, newest first. */
export const AuditLogCard = () => {
  const { results, status, loadMore } = usePaginatedQuery(
    api.admin.listAudit,
    {},
    { initialNumItems: PAGE_SIZE },
  );

  const renderBody = () => {
    if (status === "LoadingFirstPage") {
      return (
        <div className="space-y-2" aria-label="Loading audit log">
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
              <HistoryIcon />
            </EmptyMedia>
            <EmptyTitle>No changes yet</EmptyTitle>
            <EmptyDescription>Saved admin changes show up here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      );
    }
    return (
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-28 sm:w-36">When</TableHead>
            <TableHead className="hidden w-48 lg:table-cell">Who</TableHead>
            <TableHead className="hidden w-40 md:table-cell">Action</TableHead>
            <TableHead>Change</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {results.map((entry) => (
            <TableRow key={entry._id} className="[&>td]:align-top">
              <TableCell className="text-xs text-muted-foreground">
                <time dateTime={new Date(entry.at).toISOString()} title={format(entry.at, "PPpp")}>
                  {formatDistanceToNow(entry.at, { addSuffix: true })}
                </time>
              </TableCell>
              <TableCell className="hidden truncate text-xs lg:table-cell">{entry.actorEmail}</TableCell>
              <TableCell className="hidden md:table-cell">
                <Badge variant="outline" className="block max-w-full truncate font-mono" title={entry.action}>
                  {entry.action}
                </Badge>
              </TableCell>
              <TableCell className="text-xs break-words whitespace-normal">
                {entry.summary}
                {/* Who and Action have no column on narrow screens. */}
                <p className="mt-1 break-all text-muted-foreground lg:hidden">
                  {entry.actorEmail}
                  <span className="block font-mono md:hidden">{entry.action}</span>
                </p>
                <ChangeDetails entry={entry} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  };

  return (
    <Card>
      <CardContent className="space-y-4">
        {renderBody()}
        {(status === "CanLoadMore" || status === "LoadingMore") && (
          <div className="flex justify-center">
            <Button
              variant="outline"
              size="sm"
              onClick={() => loadMore(PAGE_SIZE)}
              disabled={status === "LoadingMore"}
            >
              {status === "LoadingMore" && <Spinner />}
              Load more
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
