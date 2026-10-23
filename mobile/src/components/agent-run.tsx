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
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

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
        <ChevronRight
          size={14}
          color={c.mutedForeground}
          style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}
        />
      </Pressable>
      {open && (
        <View style={[styles.thought, { borderColor: c.border }]}>
          <Text style={[styles.thoughtText, { color: c.mutedForeground }]}>{step.text}</Text>
        </View>
      )}
    </View>
  );
}

function StepRow({
  row,
  live,
  c,
  onOpenFile,
}: {
  row: Row;
  live: boolean;
  c: Colors;
  onOpenFile?: (path: string) => void;
}) {
  const [errorOpen, setErrorOpen] = useState(false);
  if (row.step.kind === "thinking") return row.step.text ? <ThinkingRow step={row.step} c={c} /> : null;

  const { icon: Icon } = toolMeta(row.step.tool);
  const running = live && row.step.status === "running";
  const failed = row.step.status === "error";
  const tint = failed ? c.destructive : c.mutedForeground;
  const chips = row.step.tool === "renameFile" ? row.targets.slice(-1) : row.targets.slice(0, 4);
  const more = row.targets.length - chips.length;
  const tool = row.step.tool ?? "";
  const open = NON_FILE_TOOLS.has(tool) || tool.includes("__") ? undefined : onOpenFile;

  return (
    <View>
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
    </View>
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
  onOpenFile,
}: {
  steps: AgentStep[];
  status: "processing" | "completed" | "cancelled";
  startedAt: number;
  completedAt?: number;
  model?: string;
  onOpenFile?: (path: string) => void;
}) {
  const c = useColors();
  const live = status === "processing";
  const [open, setOpen] = useState(live);
  const now = useNow(live);

  // Collapse once the run ends.
  useEffect(() => {
    if (!live) setOpen(false);
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
  const visible = live ? rows.slice(-LIVE_ROWS) : rows;
  const hidden = rows.length - visible.length;

  const summary = [
    `${toolSteps.length} ${toolSteps.length === 1 ? "step" : "steps"}`,
    changed > 0 && `${changed} ${changed === 1 ? "file" : "files"} changed`,
    model,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <View style={[styles.run, { backgroundColor: c.card, borderColor: c.border }]}>
      <Pressable style={styles.header} onPress={() => setOpen((value) => !value)} disabled={rows.length === 0}>
        {live ? (
          <>
            <ActivityIndicator size="small" color={c.brand} />
            <Text style={[styles.headerText, styles.flex, { color: c.foreground }]} numberOfLines={1}>
              {liveStepLabel(rows)}
            </Text>
            <Text style={[styles.timer, { color: c.mutedForeground }]}>{formatDuration(now - startedAt)}</Text>
          </>
        ) : (
          <>
            {errors > 0 || status === "cancelled" ? (
              <CircleAlert size={14} color={errors > 0 ? c.destructive : c.mutedForeground} />
            ) : (
              <CheckCircle2 size={14} color={c.mutedForeground} />
            )}
            <Text style={[styles.headerText, { color: c.foreground }]}>
              {status === "cancelled"
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
            <ChevronRight
              size={14}
              color={c.mutedForeground}
              style={[styles.chevron, { transform: [{ rotate: open ? "90deg" : "0deg" }] }]}
            />
          </>
        )}
      </Pressable>
      {open && rows.length > 0 && (
        <View style={[styles.body, { borderColor: c.border }]}>
          {hidden > 0 && (
            <Text style={[styles.more, styles.earlier, { color: c.mutedForeground }]}>
              +{hidden} earlier {hidden === 1 ? "step" : "steps"}
            </Text>
          )}
          {visible.map((row) => (
            <StepRow key={row.key} row={row} live={live} c={c} onOpenFile={onOpenFile} />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  run: { borderWidth: 1, borderRadius: radius.lg, overflow: "hidden" },
  header: { minHeight: 38, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12 },
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
