import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition, useReducedMotion } from "react-native-reanimated";

import {
  BookOpen,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleX,
  FilePen,
  FilePlus2,
  FileSearch,
  FileSymlink,
  FileX2,
  FolderOpen,
  FolderPlus,
  Globe,
  KeyRound,
  Lightbulb,
  type LucideIcon,
  Plug,
  Terminal,
  Wrench,
} from "@/components/icons";
import { monoLabel } from "@/components/grid";
import { fadeUp, staggerDelay } from "@/lib/motion";
import { type AgentStep, BUILD_VERIFIED, formatDuration } from "@/lib/shared";
import { type Colors, font, useColors } from "@/lib/theme";

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
  readFiles: { icon: FileSearch, running: "Reading", done: "Read", mergeable: true },
  listFiles: { icon: FolderOpen, running: "Listing files", done: "Listed files", mergeable: true },
  createFiles: { icon: FilePlus2, running: "Creating", done: "Created", writes: true },
  createFolder: { icon: FolderPlus, running: "Creating folder", done: "Created folder" },
  scaffoldViteApp: { icon: FolderPlus, running: "Scaffolding Vite app", done: "Scaffolded Vite app" },
  updateFile: { icon: FilePen, running: "Editing", done: "Edited", writes: true },
  renameFile: { icon: FileSymlink, running: "Renaming", done: "Renamed", writes: true },
  deleteFiles: { icon: FileX2, running: "Deleting", done: "Deleted", writes: true },
  scrapeUrls: { icon: Globe, running: "Fetching", done: "Fetched" },
  setEnvVar: { icon: KeyRound, running: "Setting env", done: "Set env" },
  loadSkill: { icon: BookOpen, running: "Loading skill", done: "Used skill" },
  checkBuild: { icon: Terminal, running: "Checking build", done: "Checked build" },
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

/** A live run's orange dot, pulsing in a soft halo. Reduced motion holds it still. */
function LiveDot({ c }: { c: Colors }) {
  const reduceMotion = useReducedMotion();
  return (
    <View style={styles.dotWrap}>
      <Animated.View
        style={[
          styles.halo,
          { backgroundColor: c.brand },
          !reduceMotion && {
            animationName: { "0%": { opacity: 0.35, transform: [{ scale: 0.6 }] }, "100%": { opacity: 0, transform: [{ scale: 1.6 }] } },
            animationDuration: "1.4s",
            animationIterationCount: "infinite",
            animationTimingFunction: "ease-out",
          },
        ]}
      />
      <View style={[styles.dot, { backgroundColor: c.brand }]} />
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
        monoLabel,
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

/** Tools whose targets are project files: the row shows the path. */
const FILE_TOOLS = new Set(["readFiles", "createFiles", "updateFile", "renameFile", "deleteFiles"]);

// Tailwind's purple, blue, amber, sky, yellow, teal and indigo 500s: they
// read on both themes, beside the theme's own green, orange and red.
const THOUGHT_TINT = "#8b5cf6";
const TINTS: Record<string, string> = {
  readFiles: "#3b82f6",
  listFiles: "#f59e0b",
  scrapeUrls: "#0ea5e9",
  setEnvVar: "#eab308",
  loadSkill: "#14b8a6",
};

/** The icon's tint by what the step did: added green, edited orange, removed red, the rest their own colour. */
const toolTint = (tool = "", c: Colors) =>
  ["createFiles", "createFolder", "scaffoldViteApp"].includes(tool) ? c.success
  : tool === "updateFile" || tool === "renameFile" ? c.brandText
  : tool === "deleteFiles" ? c.destructive
  : (TINTS[tool] ?? (tool.includes("__") ? "#6366f1" : c.mutedForeground));

function ThinkingRow({ step, c }: { step: AgentStep; c: Colors }) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable style={styles.row} onPress={() => setOpen((value) => !value)}>
        <Lightbulb size={15} color={THOUGHT_TINT} />
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
      <Animated.View entering={entering} style={[styles.step, { borderColor: c.border }]}>
        <ThinkingRow step={row.step} c={c} />
      </Animated.View>
    ) : null;
  }

  const meta = toolMeta(row.step.tool);
  const Icon = meta.icon;
  const tool = row.step.tool ?? "";
  const running = live && row.step.status === "running";
  const failed = row.step.status === "error";
  const verified = tool === "checkBuild" && row.step.text === BUILD_VERIFIED;
  const tint = failed ? c.destructive : verified ? c.success : toolTint(tool, c);
  // A file step reads as its path (the renamed-to one for a rename); others as their label.
  const path = FILE_TOOLS.has(tool) ? (tool === "renameFile" ? row.targets.at(-1) : row.targets[0]) : undefined;
  const more = path && tool !== "renameFile" ? row.targets.length - 1 : 0;
  const open = path && tool !== "deleteFiles" && onOpenFile ? () => onOpenFile(path) : undefined;
  const result =
    tool === "checkBuild" ? (failed ? "failed" : verified ? "passed" : row.step.text || "checked")
    : path ? (running ? meta.running : meta.done).toLowerCase()
    : undefined;

  return (
    <Animated.View entering={entering} style={[styles.step, { borderColor: c.border }]}>
      <Pressable onPress={open} disabled={!open} style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.muted }]}>
        <Icon size={15} color={tint} />
        {path ? (
          <Text style={[styles.path, { color: failed ? c.destructive : c.foreground }]} numberOfLines={1} ellipsizeMode="head">
            {path}
            {more > 0 && <Text style={{ color: c.mutedForeground }}>{`  +${more}`}</Text>}
          </Text>
        ) : (
          <Text style={[styles.rowText, { color: failed ? c.destructive : c.foreground }]} numberOfLines={1}>
            {rowLabel(row, running)}
            {row.targets[0] && <Text style={styles.target}>{` ${basename(row.targets[0])}`}</Text>}
          </Text>
        )}
        {running ? (
          <ActivityIndicator size="small" color={c.mutedForeground} />
        ) : failed ? (
          <CircleX size={14} color={c.destructive} />
        ) : (
          result && (
            <Text style={[styles.result, { color: verified ? c.success : c.mutedForeground }]} numberOfLines={1}>
              {result}
            </Text>
          )
        )}
      </Pressable>
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
  stalled = false,
  onOpenFile,
}: {
  steps: AgentStep[];
  status: "processing" | "completed" | "cancelled";
  startedAt: number;
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
  const verified = toolSteps.some((step) => step.tool === "checkBuild" && step.text === BUILD_VERIFIED);
  const hidden = live ? Math.max(0, rows.length - LIVE_ROWS) : 0;

  const summary = [
    `${toolSteps.length} ${toolSteps.length === 1 ? "step" : "steps"}`,
    changed > 0 && `${changed} ${changed === 1 ? "file" : "files"} changed`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Animated.View
      layout={LinearTransition.duration(200)}
      style={[styles.run, { backgroundColor: c.card, borderColor: c.border }]}
    >
      {/* A `[ AGENT RUN ]` strip, as on the web's windows; live, the current step. */}
      <Pressable
        style={({ pressed }) => [styles.header, { backgroundColor: pressed ? c.muted : c.background }]}
        onPress={() => {
          toggled.current = true;
          setOpen((value) => !value);
        }}
        disabled={rows.length === 0}
      >
        {live ? (
          <>
            <LiveDot c={c} />
            <LiveLabel text={liveStepLabel(rows)} c={c} />
            <Text style={[monoLabel, styles.timer, { color: c.mutedForeground }]}>{formatDuration(now - startedAt)}</Text>
          </>
        ) : (
          <Animated.View entering={startedLive ? FadeIn.duration(300) : undefined} style={styles.summary}>
            <View style={[styles.bar, { backgroundColor: c.brand }]} />
            <Text style={[monoLabel, styles.flex, { color: c.mutedForeground }]}>[ Agent run ]</Text>
            {stalled || errors > 0 || status === "cancelled" ? (
              <>
                <CircleAlert size={13} color={status === "cancelled" && !stalled ? c.mutedForeground : c.destructive} />
                <Text
                  style={[monoLabel, { color: status === "cancelled" && !stalled ? c.mutedForeground : c.destructive }]}
                  numberOfLines={1}
                >
                  {stalled
                    ? "Stopped responding"
                    : status === "cancelled"
                      ? `Stopped · ${toolSteps.length} ${toolSteps.length === 1 ? "step" : "steps"}`
                      : `${errors} ${errors === 1 ? "error" : "errors"}`}
                </Text>
              </>
            ) : verified ? (
              <>
                <CheckCircle2 size={13} color={c.success} />
                <Text style={[monoLabel, { color: c.success }]}>Build verified</Text>
              </>
            ) : (
              <Text style={[monoLabel, { color: c.mutedForeground }]} numberOfLines={1}>
                {summary}
              </Text>
            )}
            <Chevron open={open} c={c} />
          </Animated.View>
        )}
      </Pressable>
      {open && rows.length > 0 && (
        <Animated.View
          entering={FadeIn.duration(200)}
          exiting={FadeOut.duration(150)}
          style={{ backgroundColor: c.card }}
        >
          {hidden > 0 && (
            <Text style={[styles.more, styles.earlier, { color: c.mutedForeground, borderColor: c.border }]}>
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
  run: { borderWidth: 1, borderRadius: 6, overflow: "hidden" },
  header: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14 },
  summary: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8 },
  bar: { width: 2, height: 12, marginRight: 2 },
  dotWrap: { width: 16, height: 16, alignItems: "center", justifyContent: "center" },
  halo: { position: "absolute", width: 16, height: 16, borderRadius: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  timer: { fontVariant: ["tabular-nums"] },
  step: { borderTopWidth: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 11 },
  rowText: { flex: 1, fontSize: 13, fontFamily: font.regular },
  target: { fontFamily: font.mono, fontSize: 12.5 },
  path: { flex: 1, fontSize: 13, fontFamily: font.mono },
  result: { fontSize: 12, fontFamily: font.mono, maxWidth: "40%" },
  more: { fontSize: 12, fontFamily: font.regular },
  earlier: { borderTopWidth: 1, paddingLeft: 38, paddingVertical: 9 },
  thought: { marginLeft: 38, borderLeftWidth: 1, paddingLeft: 12, marginBottom: 10 },
  thoughtText: { fontSize: 12.5, lineHeight: 19, fontFamily: font.regular },
  error: { fontSize: 12, paddingLeft: 38, paddingRight: 14, paddingBottom: 10, fontFamily: font.regular },
});
