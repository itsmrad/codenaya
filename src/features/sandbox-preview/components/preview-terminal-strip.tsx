"use client";

import { ChevronUpIcon, TerminalSquareIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { createStoredChoice } from "../hooks/use-stored-choice";
import { lastLogLine } from "../utils/last-log-line";

type TerminalChoice = "open" | "closed";

/** Whether the user keeps the preview terminal open, persisted per browser. */
export const usePreviewTerminal = createStoredChoice<TerminalChoice>(
  "codenaya:preview-terminal",
  (value): value is TerminalChoice => value === "open" || value === "closed",
  "closed",
);

const STATUSES: Record<string, { label: string; dot: string }> = {
  idle: { label: "Idle", dot: "bg-muted-foreground/50" },
  booting: { label: "Starting", dot: "bg-amber-500 animate-pulse" },
  installing: { label: "Installing", dot: "bg-amber-500 animate-pulse" },
  running: { label: "Running", dot: "bg-emerald-500" },
  error: { label: "Error", dot: "bg-destructive" },
};

export const PreviewStatusBadge = ({ status }: { status: string }) => {
  const { label, dot } = STATUSES[status] ?? STATUSES.idle;
  return (
    <Badge
      variant="outline"
      className="h-5 gap-1.5 px-1.5 text-[11px] border-border/60 bg-background/60"
    >
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", dot)} />
      {label}
    </Badge>
  );
};

/**
 * The collapsed terminal: engine status and the latest output line, so new
 * output stays visible without giving up the preview's height.
 */
export const PreviewTerminalStrip = ({
  status,
  output,
  placeholder,
  onExpand,
}: {
  status: string;
  output: string;
  /** Shown until the engine writes its first line. */
  placeholder: string;
  onExpand: () => void;
}) => {
  const line = lastLogLine(output);

  return (
    <button
      type="button"
      onClick={onExpand}
      aria-expanded={false}
      title={line || undefined}
      data-status={status}
      className="group h-7 w-full shrink-0 flex items-center gap-2 rounded-lg border border-border/50 bg-sidebar pl-1 pr-2 text-left text-xs shadow-sm transition-colors hover:bg-muted/60 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <PreviewStatusBadge status={status} />
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
        {line || placeholder}
      </span>
      <span className="shrink-0 flex items-center gap-1 font-medium text-muted-foreground transition-colors group-hover:text-foreground">
        <TerminalSquareIcon aria-hidden="true" className="size-3.5" />
        <span className="sr-only @sm:not-sr-only">Show logs</span>
        <ChevronUpIcon aria-hidden="true" className="size-3.5" />
      </span>
    </button>
  );
};
