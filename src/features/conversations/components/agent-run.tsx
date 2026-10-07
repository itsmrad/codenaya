"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import {
  BookOpenIcon,
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

import { type AgentStep, STALLED_RUN_MS, lastRunActivity } from "../agent-steps";
import { LoaderGrid } from "./run-loader";

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
  loadSkill: { icon: BookOpenIcon, running: "Loading skill", done: "Used skill" },
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
          endedAt: step.endedAt ?? previous.step.endedAt,
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
  /** A skill, URL or env var name rather than a project file. */
  label?: boolean;
}

const FileChip = ({ path, onOpen, label = false }: FileChipProps) => {
  const className = cn(
    "inline-flex h-5.5 min-w-0 max-w-[55%] @sm:max-w-[60%] items-center rounded-[6px] bg-muted/60 px-1.5 text-[11.5px] text-foreground/90 shadow-[inset_0_0_0_1px_var(--border)]",
    label ? "font-sans" : "font-mono",
  );
  const name = <span className="truncate">{label ? path : basename(path)}</span>;
  return onOpen ? (
    <button
      type="button"
      title={path}
      onClick={() => onOpen(path)}
      className={cn(className, "transition-colors duration-150 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 motion-reduce:transition-none")}
    >
      {name}
    </button>
  ) : (
    <span title={path} className={className}>
      {name}
    </span>
  );
};

/** Chips shown before a long list collapses into "+N more". */
const CHIP_LIMIT = 6;

/** Tools whose targets are not project files: their chips never open. */
const NON_FILE_TOOLS = new Set(["scrapeUrls", "setEnvVar", "loadSkill"]);

const isFileTool = (tool = "") => !NON_FILE_TOOLS.has(tool) && !tool.includes("__");

const Targets = ({
  row,
  onOpenFile,
}: {
  row: Row;
  onOpenFile?: (path: string) => void;
}) => {
  const [expanded, setExpanded] = useState(false);
  const { tool } = row.step;
  const files = isFileTool(tool);
  const open = files && tool !== "deleteFiles" ? onOpenFile : undefined;
  if (tool === "renameFile" && row.targets.length === 2) {
    return (
      <>
        <FileChip path={row.targets[0]} />
        <span className="text-muted-foreground">→</span>
        <FileChip path={row.targets[1]} />
      </>
    );
  }
  const visible = expanded ? row.targets : row.targets.slice(0, CHIP_LIMIT);
  const more = row.targets.length - visible.length;
  return (
    <>
      {visible.map((target, index) => (
        <FileChip key={`${target}-${index}`} path={target} onOpen={open} label={!files} />
      ))}
      {more > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="h-5.5 rounded-[6px] px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          +{more} more
        </button>
      )}
    </>
  );
};

/** Icon on the timeline rule: opaque so the rule stops at it, hover included. */
const RULE_ICON =
  "relative z-10 size-3.5 shrink-0 bg-card text-muted-foreground transition-colors duration-150 group-hover/step:bg-[color-mix(in_srgb,var(--accent)_40%,var(--card))] motion-reduce:transition-none";

const ThinkingRow = ({ step }: { step: AgentStep }) => {
  const [expanded, setExpanded] = useState(false);
  const text = step.text ?? "";
  return (
    <Collapsible>
      <CollapsibleTrigger className="group/step flex min-h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-[13px] text-foreground/80 outline-none transition-colors duration-150 hover:bg-accent/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 motion-reduce:transition-none">
        <BrainIcon className={RULE_ICON} />
        <span>
          {step.endedAt ? `Thought for ${formatDuration(step.endedAt - step.startedAt)}` : "Thought"}
        </span>
        <ChevronRightIcon className="size-3.5 text-muted-foreground transition-transform duration-200 group-data-[state=open]/step:rotate-90 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down motion-reduce:animate-none">
        <div className="mb-1 ml-7 border-l border-border pl-3">
          <p
            className={cn(
              "whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-muted-foreground",
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

/** Stagger between rows arriving in the same update, capped so a burst of
 *  steps doesn't trail in behind the run. */
const staggerDelay = (index: number, step: number) => `${Math.min(index, 5) * step}ms`;

const StepRow = ({
  row,
  live,
  entryIndex,
  onOpenFile,
}: {
  row: Row;
  live: boolean;
  /** Position within the batch of rows that just arrived; unset for rows
   *  already there when the run mounted (history never re-animates). */
  entryIndex?: number;
  onOpenFile?: (path: string) => void;
}) => {
  // Decided once, on mount: later batches must not restart this row's entry.
  const [entry] = useState<CSSProperties | undefined>(() =>
    entryIndex === undefined ? undefined : { animationDelay: staggerDelay(entryIndex, 60) },
  );
  const entryClass = entry && "animate-fade-up motion-reduce:animate-none";

  if (row.step.kind === "thinking") {
    return row.step.text ? (
      <div className={cn(entryClass)} style={entry}>
        <ThinkingRow step={row.step} />
      </div>
    ) : null;
  }
  const { icon: Icon } = toolMeta(row.step.tool);
  const running = live && row.step.status === "running";
  const failed = row.step.status === "error";
  return (
    <div className={cn(entryClass)} style={entry}>
      {/* Icon column + label column: chips wrap under the label, clear of
          the icon column and the timeline rule drawn through it. */}
      <div
        className={cn(
          "group/step flex min-h-7 min-w-0 items-start gap-2 rounded-md px-1.5 py-1 text-[13px] text-foreground/80 transition-colors duration-150 hover:bg-accent/40 motion-reduce:transition-none",
          failed && "text-destructive",
        )}
      >
        <Icon className={cn(RULE_ICON, "mt-[3px]", failed && "text-destructive")} />
        <div className="flex min-h-5 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="shrink-0">{rowLabel(row, running)}</span>
          <Targets row={row} onOpenFile={onOpenFile} />
        </div>
        {running && (
          <span
            aria-hidden
            className="mt-1 size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-border border-t-foreground/70 motion-reduce:animate-none"
          />
        )}
        {failed && <CircleXIcon className="mt-[3px] size-3.5 shrink-0 text-destructive" />}
      </div>
      {failed && row.step.error && (
        <p className="truncate pb-1 pl-7 text-xs text-muted-foreground" title={row.step.error}>
          {row.step.error}
        </p>
      )}
    </div>
  );
};

/** What a live run is doing right now, e.g. "Creating page.tsx…". */
export const liveStepLabel = (steps: AgentStep[]) => {
  const current = [...toRows(steps)].reverse().find((row) => row.step.status === "running");
  return current
    ? `${rowLabel(current, true)}${current.targets[0] ? ` ${basename(current.targets[0])}` : ""}…`
    : "Thinking…";
};

export const useNow = (active: boolean) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
};

interface RunProgress {
  status?: "processing" | "completed" | "cancelled";
  _creationTime: number;
  steps?: AgentStep[];
}

/**
 * True once a processing run has gone `STALLED_RUN_MS` without progress: it
 * most likely died without reporting back. Wakes once at the deadline rather
 * than ticking, and resets when a new step arrives.
 */
export const useRunStalled = (run: RunProgress | undefined) => {
  const deadline =
    run?.status === "processing"
      ? lastRunActivity(run._creationTime, run.steps ?? []) + STALLED_RUN_MS
      : undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === undefined) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [deadline]);
  return deadline !== undefined && now >= deadline;
};

const LIVE_ROWS = 4;

/** Changed-file chips shown before the rest collapse into "+N more". */
const CHANGED_LIMIT = 4;

/** Files a run created, edited or renamed into, in the order first written. */
const changedFiles = (toolSteps: AgentStep[]) => [
  ...new Set(
    toolSteps
      .filter((step) => step.status === "done" && toolMeta(step.tool).writes)
      .flatMap((step) =>
        step.tool === "deleteFiles"
          ? []
          : step.tool === "renameFile"
            ? (step.targets ?? []).slice(1)
            : (step.targets ?? []),
      ),
  ),
];

/**
 * What a finished run wrote, one chip per file. `animate` pops the chips in
 * when the run settles in front of the user, not when history loads.
 */
const ChangedFiles = ({
  paths,
  animate,
  onOpenFile,
}: {
  paths: string[];
  animate: boolean;
  onOpenFile?: (path: string) => void;
}) => {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? paths : paths.slice(0, CHANGED_LIMIT);
  const more = paths.length - visible.length;
  return (
    <div
      data-slot="changed-files"
      className="flex flex-wrap gap-1.5 border-t border-border px-3 py-2"
    >
      {visible.map((path, index) => (
        <button
          key={path}
          type="button"
          title={path}
          disabled={!onOpenFile}
          onClick={() => onOpenFile?.(path)}
          className={cn(
            "inline-flex h-7 min-w-0 max-w-full items-center rounded-md bg-muted/60 px-2 font-mono text-[11.5px] text-foreground/90 shadow-[inset_0_0_0_1px_var(--border)] transition-colors duration-150 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:hover:bg-muted/60 motion-reduce:transition-none",
            animate &&
              "animate-in fade-in-0 zoom-in-95 fill-mode-both duration-250 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:animate-none",
          )}
          style={animate ? { animationDelay: staggerDelay(index, 80) } : undefined}
        >
          <span className="truncate">{basename(path)}</span>
        </button>
      ))}
      {more > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="h-7 rounded-md px-1.5 font-mono text-[11.5px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          +{more} more
        </button>
      )}
    </div>
  );
};

interface AgentRunProps {
  steps: AgentStep[];
  status: "processing" | "completed" | "cancelled";
  startedAt: number;
  completedAt?: number;
  /** "Provider · model" the run used, when recorded. */
  model?: string;
  /** Processing, but silent for too long (see `useRunStalled`). */
  stalled?: boolean;
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
  model,
  stalled = false,
  onOpenFile,
}: AgentRunProps) => {
  const live = status === "processing" && !stalled;
  const [open, setOpen] = useState(live);
  const [showAll, setShowAll] = useState(false);
  const toggled = useRef(false);
  const now = useNow(live);
  const reduceMotion = useReducedMotion();
  // Mounted mid-run: it settles in front of the user, so the summary and
  // changed files animate in. A finished run loaded from history doesn't.
  const [startedLive] = useState(live);

  // Collapse shortly after the run ends, unless the user took control.
  useEffect(() => {
    if (live || toggled.current) return;
    const timer = setTimeout(() => setOpen(false), 600);
    return () => clearTimeout(timer);
  }, [live]);

  const rows = toRows(steps);
  // Rows that arrived since the last update form a batch that fades up with a
  // stagger. Rows already there on mount (history) are never animated.
  const [batch, setBatch] = useState({ count: rows.length, start: rows.length });
  if (rows.length !== batch.count) {
    setBatch({ count: rows.length, start: Math.min(batch.count, rows.length) });
  }
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
  const written = status === "completed" ? changedFiles(toolSteps) : [];
  const settle =
    startedLive && "animate-in fade-in-0 duration-300 motion-reduce:animate-none";

  const liveLabel = liveStepLabel(steps);

  const summary = [
    `${toolSteps.length} ${toolSteps.length === 1 ? "step" : "steps"}`,
    changed > 0 && `${changed} ${changed === 1 ? "file" : "files"} changed`,
    model,
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
      data-run-status={live ? "running" : stalled ? "stalled" : status}
      className="@container w-full overflow-hidden rounded-xl border border-border bg-card/60"
    >
      <CollapsibleTrigger
        disabled={rows.length === 0}
        className="group/run flex h-9 w-full items-center gap-2 px-3 text-left text-[13px] outline-none transition-colors duration-100 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 disabled:cursor-default disabled:hover:bg-transparent"
      >
        {live ? (
          <>
            <LoaderGrid />
            {reduceMotion ? (
              <span className="min-w-0 truncate text-muted-foreground">{liveLabel}</span>
            ) : (
              <Shimmer as="span" duration={1.4} className="min-w-0 truncate">
                {liveLabel}
              </Shimmer>
            )}
            <span className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              {model && (
                <span className="hidden max-w-48 truncate @sm:inline" title={model}>
                  {model} ·
                </span>
              )}
              <span className="font-mono tabular-nums">{formatDuration(now - startedAt)}</span>
            </span>
          </>
        ) : (
          <>
            {errors > 0 || stalled || status === "cancelled" ? (
              <CircleAlertIcon
                className={cn(
                  "size-3.5 shrink-0",
                  errors > 0 || stalled ? "text-destructive" : "text-muted-foreground",
                  settle,
                )}
              />
            ) : (
              <CheckCircle2Icon className={cn("size-3.5 shrink-0 text-muted-foreground", settle)} />
            )}
            <span className={cn("shrink-0 text-foreground/80", settle)}>
              {stalled
                ? "Stopped responding"
                : status === "cancelled"
                ? `Stopped after ${toolSteps.length} ${toolSteps.length === 1 ? "step" : "steps"}`
                : endedAt
                  ? `Worked for ${formatDuration(endedAt - startedAt)}`
                  : "Worked"}
            </span>
            <span className={cn("min-w-0 truncate text-muted-foreground", settle)}>
              {status !== "cancelled" && `· ${summary}`}
              {errors > 0 && (
                <span className="text-destructive">
                  {" "}· {errors} {errors === 1 ? "error" : "errors"}
                </span>
              )}
            </span>
            <ChevronRightIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]/run:rotate-90 motion-reduce:transition-none" />
          </>
        )}
      </CollapsibleTrigger>
      {rows.length > 0 && (
        <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down motion-reduce:animate-none">
          <div className="border-t border-border px-1.5 py-1.5">
            {hidden > 0 && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="mb-1 pl-7 text-xs text-muted-foreground hover:text-foreground"
              >
                +{hidden} earlier {hidden === 1 ? "step" : "steps"}
              </button>
            )}
            <div className="relative before:absolute before:inset-y-1 before:left-[12.5px] before:w-px before:bg-border">
              {rows.slice(hidden).map((row, offset) => {
                const index = hidden + offset;
                return (
                  <StepRow
                    key={row.key}
                    row={row}
                    live={live}
                    entryIndex={index >= batch.start ? index - batch.start : undefined}
                    onOpenFile={onOpenFile}
                  />
                );
              })}
            </div>
          </div>
        </CollapsibleContent>
      )}
      {written.length > 0 && (
        <ChangedFiles paths={written} animate={startedLive} onOpenFile={onOpenFile} />
      )}
    </Collapsible>
  );
};
