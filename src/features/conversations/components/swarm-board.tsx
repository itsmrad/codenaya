"use client";

import { ChevronRightIcon, UsersIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";

import type { Doc } from "../../../../convex/_generated/dataModel";
import { runWrittenPaths } from "../agent-steps";
import { type SwarmTask, swarmElapsed, swarmHeader, swarmTaskStatus } from "../swarm";
import { AgentRunLog } from "./agent-run";

const STATUS_LABELS = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  error: "Error",
  cancelled: "Cancelled",
};

const SwarmRow = ({
  task, parent, now, onOpenFile, defaultOpen, children,
}: {
  task: Omit<SwarmTask, "role" | "status"> & {
    role: SwarmTask["role"] | "orchestrator";
    status: SwarmTask["status"] | "cancelled";
  };
  parent: Doc<"messages">;
  now: number;
  onOpenFile?: (path: string) => void;
  defaultOpen?: boolean;
  children?: ReactNode;
}) => {
  const status = swarmTaskStatus(task.status, parent.status ?? "completed");
  const paths = runWrittenPaths(task.steps);
  const end = task.endedAt ?? (status === "running" ? now : parent.completedAt ?? task.updatedAt);
  const role = task.role === "orchestrator" ? "Orchestrator" : task.role === "worker" ? "Worker" : "Sub-orchestrator";
  return (
    <Collapsible defaultOpen={defaultOpen} className="min-w-0 border-t border-border">
      <CollapsibleTrigger className="group/swarm flex w-full min-w-0 items-start gap-2 p-3 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none">
        <ChevronRightIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/swarm:rotate-90 motion-reduce:transition-none" />
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <Badge variant="outline" className="shrink-0 text-[10px] font-medium">{role}</Badge>
            <span className="min-w-0 truncate text-[11px] text-muted-foreground" title={task.model}>{task.model}</span>
          </span>
          <span className="text-[13px] leading-5 [overflow-wrap:anywhere]">{task.title}</span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span aria-live="polite" className={cn("inline-flex items-center gap-1", status === "error" && "text-destructive")}>
              <span aria-hidden className={cn("size-1.5 rounded-full bg-current", status === "running" && "animate-pulse motion-reduce:animate-none")} />
              {STATUS_LABELS[status]}
            </span>
            {task.startedAt !== undefined && <span className="font-mono tabular-nums">{swarmElapsed(task.startedAt, end)}</span>}
            <span>· {paths.length} {paths.length === 1 ? "file" : "files"} touched</span>
          </span>
          {paths.length > 0 && (
            <span className="flex min-w-0 flex-wrap gap-1">
              {paths.slice(0, 3).map((path) => (
                <span key={path} title={path} className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{path}</span>
              ))}
              {paths.length > 3 && <span className="text-[10px] text-muted-foreground">+{paths.length - 3} more</span>}
            </span>
          )}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down motion-reduce:animate-none">
        <div className="space-y-2 bg-muted/20 px-2 pb-3 pt-1">
          {children ?? <AgentRunLog steps={task.steps} live={status === "running"} onOpenFile={onOpenFile} />}
          {task.steps.length === 0 && <p className="px-5 text-xs text-muted-foreground">{status === "queued" ? "Waiting to start" : "No activity recorded"}</p>}
          {task.summary && <p className="px-5 text-xs text-muted-foreground [overflow-wrap:anywhere]">{task.summary}</p>}
          {task.error && <p className="px-5 text-xs text-destructive [overflow-wrap:anywhere]">{task.error}</p>}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

/** The parent run is always first; children retain the query's creation order. */
export const SwarmBoard = ({ message, tasks, onOpenFile, children }: {
  message: Doc<"messages">;
  tasks: SwarmTask[] | undefined;
  onOpenFile?: (path: string) => void;
  children?: ReactNode;
}) => {
  const live = message.status === "processing";
  const now = useNow(live);
  const endedAt = live ? now : message.completedAt ?? Math.max(message._creationTime, ...(tasks ?? []).map((task) => task.endedAt ?? task.updatedAt));
  const orchestrator = {
    taskId: "orchestrator", role: "orchestrator" as const, title: "Coordinate the build",
    model: message.runModel?.label ?? "Run model",
    status: live ? "running" as const : message.status === "cancelled" ? "cancelled" as const : "done" as const,
    steps: message.steps ?? [], startedAt: message._creationTime,
    endedAt: live ? undefined : endedAt, updatedAt: endedAt,
  };
  return (
    <section aria-label="Swarm board" className="@container min-w-0 overflow-hidden rounded-xl border border-border bg-card/60">
      <h3 className="flex items-center gap-2 px-3 py-2.5 text-xs font-medium">
        <UsersIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="leading-5">{tasks === undefined ? "Swarm · Loading workers…" : swarmHeader(tasks, message._creationTime, endedAt)}</span>
      </h3>
      {/* Open by default: the parent run keeps its revert and fix actions in view. */}
      <SwarmRow task={orchestrator} parent={message} now={now} onOpenFile={onOpenFile} defaultOpen>{children}</SwarmRow>
      {tasks?.map((task) => <SwarmRow key={task.taskId} task={task} parent={message} now={now} onOpenFile={onOpenFile} />)}
    </section>
  );
};
