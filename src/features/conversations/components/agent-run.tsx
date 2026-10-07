"use client";

import { useEffect, useRef, useState } from "react";
import {
  BrainIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleXIcon,
  FilePenIcon,
  FilePlus2Icon,
  FileSymlinkIcon,
  FileTextIcon,
  FileX2Icon,
  FolderPlusIcon,
  FolderTreeIcon,
  GlobeIcon,
  KeyRoundIcon,
  Loader2Icon,
  PlugIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";

import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

import type { AgentStep } from "../agent-steps";

interface ToolMeta {
  icon: LucideIcon;
  running: string;
  done: string;
  /** Changes project files (counted in "N files changed"). */
  writes?: boolean;
  /** Consecutive finished calls collapse into one row. */
  mergeable?: boolean;
}

const TOOL_META: Record<string, ToolMeta> = {
  readFiles: { icon: FileTextIcon, running: "Reading", done: "Read", mergeable: true },
  listFiles: { icon: FolderTreeIcon, running: "Listing files", done: "Listed files", mergeable: true },
  createFiles: { icon: FilePlus2Icon, running: "Creating", done: "Created", writes: true },
  createFolder: { icon: FolderPlusIcon, running: "Creating folder", done: "Created folder" },
  updateFile: { icon: FilePenIcon, running: "Editing", done: "Edited", writes: true },
  renameFile: { icon: FileSymlinkIcon, running: "Renaming", done: "Renamed", writes: true },
  deleteFiles: { icon: FileX2Icon, running: "Deleting", done: "Deleted", writes: true },
  scrapeUrls: { icon: GlobeIcon, running: "Fetching", done: "Fetched" },
  setEnvVar: { icon: KeyRoundIcon, running: "Setting env", done: "Set env" },
};

const toolMeta = (tool = ""): ToolMeta => {
  if (TOOL_META[tool]) return TOOL_META[tool];
  if (tool.includes("__")) {
    const provider = tool.slice(0, tool.indexOf("__"));
    return { icon: PlugIcon, running: `Calling ${provider}`, done: `Called ${provider}` };
  }
  return { icon: WrenchIcon, running: `Running ${tool}`, done: `Ran ${tool}` };
};

const basename = (path: string) => path.split("/").pop() || path;

const formatDuration = (ms: number) => {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
};

/** A row as rendered: one step, or several merged finished reads/lists. */
interface Row {
  key: string;
  step: AgentStep;
  targets: string[];
}

const toRows = (steps: AgentStep[]): Row[] => {
  const rows: Row[] = [];
  for (const step of steps) {
    const previous = rows.at(-1);
    const merge =
      previous &&
      previous.step.kind === step.kind &&
      (step.kind === "thinking" ||
        (previous.step.tool === step.tool &&
          toolMeta(step.tool).mergeable &&
          previous.step.status === "done" &&
          step.status === "done"));
    if (merge) {
      previous.targets = [...previous.targets, ...(step.targets ?? [])];
      if (step.kind === "thinking") {
        previous.step = {
          ...previous.step,
          text: [previous.step.text, step.text].filter(Boolean).join("\n\n"),
        };
      }
      continue;
    }
    rows.push({ key: step.id, step, targets: step.targets ?? [] });
  }
  return rows;
};

const rowLabel = (row: Row, live: boolean) => {
  const meta = toolMeta(row.step.tool);
  const verb = live ? meta.running : meta.done;
  // "Read 4 files" reads better than four chips with no count.
  if (row.step.tool === "readFiles" && row.targets.length > 1) {
    return `${verb} ${row.targets.length} files`;
  }
  return verb;
};

interface FileChipProps {
  path: string;
  onOpen?: (path: string) => void;
}

const FileChip = ({ path, onOpen }: FileChipProps) => {
  const className =
    "inline-flex h-5 min-w-0 max-w-[55%] @sm:max-w-[60%] items-center rounded-[6px] border border-border bg-muted/60 px-1.5 font-mono text-[11px] text-foreground/90";
  const name = <span className="truncate">{basename(path)}</span>;
  return onOpen ? (
    <button
      type="button"
      title={path}
      onClick={() => onOpen(path)}
      className={cn(className, "transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40")}
    >
      {name}
    </button>
  ) : (
    <span title={path} className={className}>
      {name}
    </span>
  );
};

const Targets = ({
  row,
  onOpenFile,
}: {
  row: Row;
  onOpenFile?: (path: string) => void;
}) => {
  const { tool } = row.step;
  const opens = tool !== "scrapeUrls" && tool !== "setEnvVar" && !tool?.includes("__");
  const open = opens && tool !== "deleteFiles" ? onOpenFile : undefined;
  if (tool === "renameFile" && row.targets.length === 2) {
    return (
      <>
        <FileChip path={row.targets[0]} />
        <span className="text-muted-foreground">→</span>
        <FileChip path={row.targets[1]} />
      </>
    );
  }
  return row.targets.map((target, index) => (
    <FileChip key={`${target}-${index}`} path={target} onOpen={open} />
  ));
};

const ThinkingRow = ({ text }: { text: string }) => {
  const [expanded, setExpanded] = useState(false);
  return (
    <Collapsible>
      <CollapsibleTrigger className="group/think flex min-h-7 w-full items-center gap-2 rounded-md text-left text-[13px] text-foreground/80 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40">
        <BrainIcon className="relative z-10 size-3.5 shrink-0 bg-card text-muted-foreground" />
        <span>Thought</span>
        <ChevronRightIcon className="size-3.5 text-muted-foreground transition-transform duration-150 group-data-[state=open]/think:rotate-90 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down motion-reduce:animate-none">
        <div className="mb-1 ml-6 border-l border-border pl-3">
          <p
            className={cn(
              "whitespace-pre-wrap break-words text-xs/5 text-muted-foreground",
              !expanded && "line-clamp-10",
            )}
          >
            {text}
          </p>
          {!expanded && text.split("\n").length + text.length / 60 > 10 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Show more
            </button>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

const StepRow = ({
  row,
  live,
  onOpenFile,
}: {
  row: Row;
  live: boolean;
  onOpenFile?: (path: string) => void;
}) => {
  if (row.step.kind === "thinking") {
    return row.step.text ? <ThinkingRow text={row.step.text} /> : null;
  }
  const { icon: Icon } = toolMeta(row.step.tool);
  const running = live && row.step.status === "running";
  const failed = row.step.status === "error";
  return (
    <div className="animate-in fade-in-0 duration-150 motion-reduce:animate-none">
      <div
        className={cn(
          "flex min-h-7 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-0.5 text-[13px] text-foreground/80",
          failed && "text-destructive",
        )}
      >
        <Icon
          className={cn(
            "relative z-10 size-3.5 shrink-0 bg-card text-muted-foreground",
            failed && "text-destructive",
          )}
        />
        <span className="shrink-0">{rowLabel(row, running)}</span>
        <Targets row={row} onOpenFile={onOpenFile} />
        {running && (
          <Loader2Icon className="ml-auto size-3.5 shrink-0 animate-spin text-muted-foreground" />
        )}
        {failed && <CircleXIcon className="ml-auto size-3.5 shrink-0 text-destructive" />}
      </div>
      {failed && row.step.error && (
        <p className="truncate pb-1 pl-6 text-xs text-muted-foreground" title={row.step.error}>
          {row.step.error}
        </p>
      )}
    </div>
  );
};

const useNow = (active: boolean) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
};

const LIVE_ROWS = 4;

interface AgentRunProps {
  steps: AgentStep[];
  status: "processing" | "completed" | "cancelled";
  startedAt: number;
  completedAt?: number;
  onOpenFile?: (path: string) => void;
}

/**
 * One assistant turn's agent activity: a single collapsible block, live while
 * the run is going and collapsed to a one-line summary once it finishes.
 */
export const AgentRun = ({
  steps,
  status,
  startedAt,
  completedAt,
  onOpenFile,
}: AgentRunProps) => {
  const live = status === "processing";
  const [open, setOpen] = useState(live);
  const [showAll, setShowAll] = useState(false);
  const toggled = useRef(false);
  const now = useNow(live);

  // Collapse shortly after the run ends, unless the user took control.
  useEffect(() => {
    if (live || toggled.current) return;
    const timer = setTimeout(() => setOpen(false), 600);
    return () => clearTimeout(timer);
  }, [live]);

  const rows = toRows(steps);
  const toolSteps = steps.filter((step) => step.kind === "tool");
  const errors = toolSteps.filter((step) => step.status === "error").length;
  const changed = new Set(
    toolSteps
      .filter((step) => toolMeta(step.tool).writes && step.status === "done")
      .map((step) => step.targets?.[0])
      .filter(Boolean),
  ).size;
  const endedAt = completedAt ?? toolSteps.at(-1)?.endedAt;
  const hidden = live && !showAll ? Math.max(0, rows.length - LIVE_ROWS) : 0;

  const current = [...rows].reverse().find((row) => row.step.status === "running");
  const liveLabel = current
    ? `${rowLabel(current, true)}${current.targets[0] ? ` ${basename(current.targets[0])}` : ""}…`
    : "Thinking…";

  const summary = [
    `${toolSteps.length} ${toolSteps.length === 1 ? "step" : "steps"}`,
    changed > 0 && `${changed} ${changed === 1 ? "file" : "files"} changed`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        toggled.current = true;
        setOpen(next);
      }}
      data-run-status={live ? "running" : status}
      className="@container w-full overflow-hidden rounded-xl border border-border bg-card/60"
    >
      <CollapsibleTrigger
        disabled={rows.length === 0}
        className="group/run flex h-9 w-full items-center gap-2 px-3 text-left text-[13px] outline-none transition-colors duration-100 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 disabled:cursor-default disabled:hover:bg-transparent"
      >
        {live ? (
          <>
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-brand motion-reduce:animate-none" />
            <Shimmer as="span" className="min-w-0 truncate">
              {liveLabel}
            </Shimmer>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
              {formatDuration(now - startedAt)}
            </span>
          </>
        ) : (
          <>
            {errors > 0 || status === "cancelled" ? (
              <CircleAlertIcon
                className={cn(
                  "size-3.5 shrink-0",
                  errors > 0 ? "text-destructive" : "text-muted-foreground",
                )}
              />
            ) : (
              <CheckCircle2Icon className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="shrink-0 text-foreground/80">
              {status === "cancelled"
                ? `Stopped after ${toolSteps.length} ${toolSteps.length === 1 ? "step" : "steps"}`
                : endedAt
                  ? `Worked for ${formatDuration(endedAt - startedAt)}`
                  : "Worked"}
            </span>
            <span className="min-w-0 truncate text-muted-foreground">
              {status !== "cancelled" && `· ${summary}`}
              {errors > 0 && (
                <span className="text-destructive">
                  {" "}· {errors} {errors === 1 ? "error" : "errors"}
                </span>
              )}
            </span>
            <ChevronRightIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]/run:rotate-90 motion-reduce:transition-none" />
          </>
        )}
      </CollapsibleTrigger>
      {rows.length > 0 && (
        <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down motion-reduce:animate-none">
          <div className="border-t border-border px-3 py-2">
            {hidden > 0 && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="mb-1 pl-6 text-xs text-muted-foreground hover:text-foreground"
              >
                +{hidden} earlier {hidden === 1 ? "step" : "steps"}
              </button>
            )}
            <div className="relative before:absolute before:inset-y-1 before:left-[6.5px] before:w-px before:bg-border">
              {rows.slice(hidden).map((row) => (
                <StepRow key={row.key} row={row} live={live} onOpenFile={onOpenFile} />
              ))}
            </div>
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
};
