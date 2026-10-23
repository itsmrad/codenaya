import {
  BookOpen,
  Brain,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleX,
  FilePen,
  FilePlus2,
  FileSymlink,
  FileText,
  FileX2,
  FolderPlus,
  FolderTree,
  Globe,
  Hammer,
  KeyRound,
  type LucideIcon,
  Plug,
  Wrench,
} from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition, useReducedMotion } from "react-native-reanimated";

import { fadeUp, staggerDelay } from "@/lib/motion";
import { type AgentStep, BUILD_VERIFIED, formatDuration } from "@/lib/shared";
import { type Colors, font, radius, useColors } from "@/lib/theme";

// ponytail: labels and row merging are ported from the web's agent-run.tsx
// (a web component, so it can't be imported). Move them into agent-steps.ts
// if the two drift.

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
  readFiles: { icon: FileText, running: "Reading", done: "Read", mergeable: true },
  listFiles: { icon: FolderTree, running: "Listing files", done: "Listed files", mergeable: true },
  createFiles: { icon: FilePlus2, running: "Creating", done: "Created", writes: true },
  createFolder: { icon: FolderPlus, running: "Creating folder", done: "Created folder" },
  scaffoldViteApp: { icon: FolderPlus, running: "Scaffolding Vite app", done: "Scaffolded Vite app" },
  updateFile: { icon: FilePen, running: "Editing", done: "Edited", writes: true },
  renameFile: { icon: FileSymlink, running: "Renaming", done: "Renamed", writes: true },
  deleteFiles: { icon: FileX2, running: "Deleting", done: "Deleted", writes: true },
  scrapeUrls: { icon: Globe, running: "Fetching", done: "Fetched" },
  setEnvVar: { icon: KeyRound, running: "Setting env", done: "Set env" },
  loadSkill: { icon: BookOpen, running: "Loading skill", done: "Used skill" },
  checkBuild: { icon: Hammer, running: "Checking build", done: "Checked build" },
};

const toolMeta = (tool = ""): ToolMeta => {
  if (TOOL_META[tool]) return TOOL_META[tool];
  if (tool.includes("__")) {
    const provider = tool.slice(0, tool.indexOf("__"));
    return { icon: Plug, running: `Calling ${provider}`, done: `Called ${provider}` };
  }
  return { icon: Wrench, running: `Running ${tool}`, done: `Ran ${tool}` };
};

const basename = (path: string) => path.split("/").pop() || path;

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
  const verb = live ? meta.running : (row.step.tool === "checkBuild" && row.step.text) || meta.done;
  if (row.step.tool === "readFiles" && row.targets.length > 1) {
    return `${verb} ${row.targets.length} files`;
  }
  return verb;
};

/** What a live run is doing right now, e.g. "Creating page.tsx…". */
const liveStepLabel = (rows: Row[]) => {
  const current = [...rows].reverse().find((row) => row.step.status === "running");
  return current
    ? `${rowLabel(current, true)}${current.targets[0] ? ` ${basename(current.targets[0])}` : ""}…`
    : "Thinking…";
};

/** Ticks once a second while `active`, for the live run's timer. */
const useNow = (active: boolean) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
};

/**
 * Per-cell delays (ms) of the web's pixel loader (run-loader.tsx): a 3×3 grid
 * with a chevron wavefront driving right.
 */
const CHEVRON = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3);
  const column = index % 3;
  return (column + Math.abs(row - 1)) * 90;
});

// The web's pixel-on keyframes (globals.css).
const PIXEL_ON = {
  "0%, 100%": { opacity: 0.15 },
  "18%, 42%": { opacity: 1 },
  "62%": { opacity: 0.15 },
};

/** The web's live-run loader. Reduced motion freezes it with the centre lit. */
function LoaderGrid({ c }: { c: Colors }) {
  const reduceMotion = useReducedMotion();
  return (
    <View style={styles.grid}>
      {CHEVRON.map((delay, index) => (
        <Animated.View
          key={index}
          style={[
            styles.pixel,
            { backgroundColor: c.brand, opacity: reduceMotion && index === 4 ? 1 : 0.15 },
            !reduceMotion && {
              animationName: PIXEL_ON,
              animationDuration: "650ms",
              animationDelay: `${delay}ms`,
              animationIterationCount: "infinite",
              animationTimingFunction: "ease-in-out",
            },
          ]}
        />
      ))}
    </View>
  );
}

/**
 * The live step label. The web sweeps a shimmer across it; without a gradient
 * text library a soft pulse at the same pace stands in.
 */
function LiveLabel({ text, c }: { text: string; c: Colors }) {
  const reduceMotion = useReducedMotion();
  return (
    <Animated.Text
      numberOfLines={1}
      style={[
        styles.headerText,
        styles.flex,
        { color: reduceMotion ? c.mutedForeground : c.foreground },
        !reduceMotion && {
          animationName: { "0%": { opacity: 1 }, "50%": { opacity: 0.45 }, "100%": { opacity: 1 } },
          animationDuration: "1.4s",
          animationIterationCount: "infinite",
          animationTimingFunction: "linear",
        },
      ]}
    >
      {text}
    </Animated.Text>
  );
}

/** A chevron that turns to point down when open, like the web's collapsible. */
function Chevron({ open, c, style }: { open: boolean; c: Colors; style?: object }) {
  return (
    <Animated.View
      style={[
        style,
        { transform: [{ rotate: open ? "90deg" : "0deg" }], transitionProperty: "transform", transitionDuration: 150 },
      ]}
    >
      <ChevronRight size={14} color={c.mutedForeground} />
    </Animated.View>
  );
}

/** Tools whose targets are not project files: their chips never open. */
const NON_FILE_TOOLS = new Set(["scrapeUrls", "setEnvVar", "loadSkill", "checkBuild", "deleteFiles"]);

function Chip({ label, c, onPress }: { label: string; c: Colors; onPress?: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={[styles.chip, { backgroundColor: c.muted, borderColor: c.border }]}
    >
      <Text style={[styles.chipText, { color: c.foreground }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function ThinkingRow({ step, c }: { step: AgentStep; c: Colors }) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable style={styles.row} onPress={() => setOpen((value) => !value)}>
        <Brain size={14} color={c.mutedForeground} />
        <Text style={[styles.rowText, { color: c.foreground }]}>
          {step.endedAt ? `Thought for ${formatDuration(step.endedAt - step.startedAt)}` : "Thought"}
        </Text>
        <Chevron open={open} c={c} />
      </Pressable>
      {open && (
        <Animated.View entering={FadeIn.duration(200)} style={[styles.thought, { borderColor: c.border }]}>
          <Text style={[styles.thoughtText, { color: c.mutedForeground }]}>{step.text}</Text>
        </Animated.View>
      )}
    </View>
  );
}

function StepRow({
  row,
  live,
  entryIndex,
  c,
  onOpenFile,
}: {
  row: Row;
  live: boolean;
  /** Position within the batch of rows that just arrived; unset for rows
   *  already there when the run mounted (history never animates). */
  entryIndex?: number;
  c: Colors;
  onOpenFile?: (path: string) => void;
}) {
  const [errorOpen, setErrorOpen] = useState(false);
  const entering = entryIndex === undefined ? undefined : fadeUp({ delay: staggerDelay(entryIndex, 60) });
  if (row.step.kind === "thinking") {
    return row.step.text ? (
      <Animated.View entering={entering}>
        <ThinkingRow step={row.step} c={c} />
      </Animated.View>
    ) : null;
  }

  const { icon: Icon } = toolMeta(row.step.tool);
  const running = live && row.step.status === "running";
  const failed = row.step.status === "error";
  const tint = failed ? c.destructive : c.mutedForeground;
  const chips = row.step.tool === "renameFile" ? row.targets.slice(-1) : row.targets.slice(0, 4);
  const more = row.targets.length - chips.length;
  const tool = row.step.tool ?? "";
  const open = NON_FILE_TOOLS.has(tool) || tool.includes("__") ? undefined : onOpenFile;

  return (
    <Animated.View entering={entering}>
      <View style={styles.row}>
        <Icon size={14} color={tint} />
        <View style={styles.rowBody}>
          <Text style={[styles.rowText, { color: failed ? c.destructive : c.foreground }]}>
            {rowLabel(row, running)}
          </Text>
          {chips.map((target, index) => (
            <Chip
              key={`${target}-${index}`}
              label={basename(target)}
              c={c}
              onPress={open && (() => open(target))}
            />
          ))}
          {more > 0 && row.step.tool !== "renameFile" && (
            <Text style={[styles.more, { color: c.mutedForeground }]}>+{more} more</Text>
          )}
        </View>
        {running && <ActivityIndicator size="small" color={c.mutedForeground} />}
        {failed && <CircleX size={14} color={c.destructive} />}
        {row.step.tool === "checkBuild" && row.step.text === BUILD_VERIFIED && (
          <CheckCircle2 size={14} color={c.mutedForeground} />
        )}
      </View>
      {failed && row.step.error && (
        <Pressable onPress={() => setErrorOpen((value) => !value)}>
          <Text
            style={[styles.error, { color: c.mutedForeground }]}
            numberOfLines={errorOpen ? undefined : 1}
          >
            {row.step.error}
          </Text>
        </Pressable>
      )}
    </Animated.View>
  );
}

/** Rows shown while live; earlier ones hide behind "+N earlier steps". */
const LIVE_ROWS = 4;

/**
 * One assistant turn's agent activity, like the web's AgentRun: live with a
 * timer while running, then a one-line summary that expands to every step.
 */
export function AgentRun({
  steps,
  status,
  startedAt,
  completedAt,
  model,
  stalled = false,
  onOpenFile,
}: {
  steps: AgentStep[];
  status: "processing" | "completed" | "cancelled";
  startedAt: number;
  completedAt?: number;
  model?: string;
  /** Processing, but silent for too long (see useRunStalled). */
  stalled?: boolean;
  onOpenFile?: (path: string) => void;
}) {
  const c = useColors();
  const live = status === "processing" && !stalled;
  const [open, setOpen] = useState(live);
  const toggled = useRef(false);
  const now = useNow(live);
  // Mounted mid-run: the summary settles in when it ends. History stays still.
  const [startedLive] = useState(live);

  // Collapse shortly after the run ends, unless the user took control.
  useEffect(() => {
    if (live || toggled.current) return;
    const timer = setTimeout(() => setOpen(false), 600);
    return () => clearTimeout(timer);
  }, [live]);

  const rows = toRows(steps);
  // Rows that arrived since the last update form a batch that fades up with a
  // stagger. Rows already there on mount (history) never animate.
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
  const hidden = live ? Math.max(0, rows.length - LIVE_ROWS) : 0;

  const summary = [
    `${toolSteps.length} ${toolSteps.length === 1 ? "step" : "steps"}`,
    changed > 0 && `${changed} ${changed === 1 ? "file" : "files"} changed`,
    model,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Animated.View
      layout={LinearTransition.duration(200)}
      style={[styles.run, { backgroundColor: c.card, borderColor: c.border }]}
    >
      <Pressable
        style={({ pressed }) => [styles.header, pressed && { backgroundColor: c.muted }]}
        onPress={() => {
          toggled.current = true;
          setOpen((value) => !value);
        }}
        disabled={rows.length === 0}
      >
        {live ? (
          <>
            <LoaderGrid c={c} />
            <LiveLabel text={liveStepLabel(rows)} c={c} />
            <Text style={[styles.timer, { color: c.mutedForeground }]}>{formatDuration(now - startedAt)}</Text>
          </>
        ) : (
          <Animated.View entering={startedLive ? FadeIn.duration(300) : undefined} style={styles.summary}>
            {errors > 0 || stalled || status === "cancelled" ? (
              <CircleAlert size={14} color={errors > 0 || stalled ? c.destructive : c.mutedForeground} />
            ) : (
              <CheckCircle2 size={14} color={c.mutedForeground} />
            )}
            <Text style={[styles.headerText, { color: c.foreground }]}>
              {stalled
                ? "Stopped responding"
                : status === "cancelled"
                ? `Stopped after ${toolSteps.length} ${toolSteps.length === 1 ? "step" : "steps"}`
                : endedAt
                  ? `Worked for ${formatDuration(endedAt - startedAt)}`
                  : "Worked"}
            </Text>
            {status !== "cancelled" && (
              <Text style={[styles.headerText, styles.flex, { color: c.mutedForeground }]} numberOfLines={1}>
                · {summary}
              </Text>
            )}
            {errors > 0 && (
              <Text style={[styles.headerText, { color: c.destructive }]}>
                · {errors} {errors === 1 ? "error" : "errors"}
              </Text>
            )}
            <Chevron open={open} c={c} style={styles.chevron} />
          </Animated.View>
        )}
      </Pressable>
      {open && rows.length > 0 && (
        <Animated.View
          entering={FadeIn.duration(200)}
          exiting={FadeOut.duration(150)}
          style={[styles.body, { borderColor: c.border }]}
        >
          {hidden > 0 && (
            <Text style={[styles.more, styles.earlier, { color: c.mutedForeground }]}>
              +{hidden} earlier {hidden === 1 ? "step" : "steps"}
            </Text>
          )}
          {rows.slice(hidden).map((row, index) => {
            const position = hidden + index;
            return (
              <StepRow
                key={row.key}
                row={row}
                live={live}
                entryIndex={position >= batch.start ? position - batch.start : undefined}
                c={c}
                onOpenFile={onOpenFile}
              />
            );
          })}
        </Animated.View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  run: { borderWidth: 1, borderRadius: radius.lg, overflow: "hidden" },
  header: { minHeight: 38, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12 },
  summary: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8 },
  grid: { width: 15, flexDirection: "row", flexWrap: "wrap", gap: 1.5 },
  pixel: { width: 4, height: 4, borderRadius: 1 },
  headerText: { fontSize: 13, fontFamily: font.regular },
  timer: { fontSize: 12, fontFamily: font.regular, fontVariant: ["tabular-nums"] },
  chevron: { marginLeft: "auto" },
  body: { borderTopWidth: 1, paddingHorizontal: 8, paddingVertical: 6, gap: 2 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingHorizontal: 4, paddingVertical: 5 },
  rowBody: { flex: 1, flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  rowText: { fontSize: 13, fontFamily: font.regular },
  chip: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1, maxWidth: "70%" },
  chipText: { fontSize: 11.5, fontFamily: "monospace" },
  more: { fontSize: 12, fontFamily: font.regular },
  earlier: { paddingLeft: 26, paddingVertical: 4 },
  thought: { marginLeft: 26, borderLeftWidth: 1, paddingLeft: 12, marginBottom: 4 },
  thoughtText: { fontSize: 12.5, lineHeight: 19, fontFamily: font.regular },
  error: { fontSize: 12, paddingLeft: 26, paddingBottom: 4, fontFamily: font.regular },
});
