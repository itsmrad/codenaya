import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { type ReactNode, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View, useColorScheme } from "react-native";
import { useMarkdown } from "react-native-marked";
import Animated, { useReducedMotion } from "react-native-reanimated";

import type { Doc } from "../../../convex/_generated/dataModel";
import { AgentRun } from "@/components/agent-run";
import { monoLabel } from "@/components/grid";
import { BookOpen, Check, Copy, Hammer, ListChecks, RotateCcw, Undo2 } from "@/components/icons";
import { Logo } from "@/components/logo";
import { timeAgo } from "@/lib/format";
import { fadeUp } from "@/lib/motion";
import { STALLED_RUN_MS, formatDuration, lastRunActivity, sanitizeAgentText, splitSlashSkills } from "@/lib/shared";
import { type Colors, font, radius, useColors } from "@/lib/theme";

/**
 * The user's message: a `YOU · time` label, then images above a card on the right.
 * Leading `/name` tokens that name an enabled skill show as chips.
 */
export function UserMessage({
  content,
  imageUrls = [],
  skillNames,
  animate = false,
  time,
}: {
  content: string;
  imageUrls?: string[];
  /** When it was sent; unset while it is still sending. */
  time?: number;
  skillNames?: ReadonlySet<string>;
  /** Fades up on mount: a message that arrived while the chat was open. */
  animate?: boolean;
}) {
  const c = useColors();
  const { names, rest } = splitSlashSkills(content);
  const skills = names.filter((name) => skillNames?.has(name));
  // Tokens that name no enabled skill stay in the text as typed.
  const text = skills.length
    ? names.filter((name) => !skillNames?.has(name)).map((name) => `/${name} `).join("") + rest
    : content;

  return (
    <Animated.View entering={animate ? fadeUp() : undefined} style={styles.user}>
      <Text style={[monoLabel, { color: c.mutedForeground }]}>{time ? `You · ${timeAgo(time)}` : "You"}</Text>
      {imageUrls.length > 0 && (
        <View style={styles.images}>
          {imageUrls.map((url) => (
            <Image key={url} source={url} style={[styles.image, { borderColor: c.border }]} contentFit="cover" />
          ))}
        </View>
      )}
      {(text.trim() || skills.length > 0) && (
        <View style={[styles.bubble, { backgroundColor: c.card, borderColor: c.border }]}>
          {skills.length > 0 && (
            <View style={styles.skills}>
              {skills.map((name) => (
                <View key={name} style={[styles.skill, { borderColor: c.border, backgroundColor: c.muted }]}>
                  <BookOpen size={11} color={c.foreground} />
                  <Text style={[styles.skillText, { color: c.foreground }]}>/{name}</Text>
                </View>
              ))}
            </View>
          )}
          {text.trim() ? <Text style={[styles.userText, { color: c.foreground }]}>{text}</Text> : null}
        </View>
      )}
    </Animated.View>
  );
}

/**
 * Reveals text a few characters per frame, like the web's useTypewriter, so a
 * reply that arrives while the user watches types out. Off: full text.
 */
const useTypewriter = (text: string, animate: boolean) => {
  const [shown, setShown] = useState(animate ? 0 : text.length);
  useEffect(() => {
    if (shown >= text.length) return;
    const frame = requestAnimationFrame(() =>
      setShown((s) => Math.min(text.length, s + Math.min(8, Math.max(1, Math.ceil((text.length - s) / 40))))),
    );
    return () => cancelAnimationFrame(frame);
  }, [shown, text.length]);
  return animate ? text.slice(0, shown) : text;
};

function Reply({ content }: { content: string }) {
  const c = useColors();
  const scheme = useColorScheme();
  const elements = useMarkdown(content, {
    colorScheme: scheme === "light" ? "light" : "dark",
    theme: { colors: { text: c.foreground, link: c.brandText, code: c.muted, border: c.border } },
    styles: {
      text: { fontFamily: font.regular, fontSize: 15, lineHeight: 24, color: c.foreground },
      strong: { fontFamily: font.semibold },
      h1: { fontFamily: font.semibold, fontSize: 20 },
      h2: { fontFamily: font.semibold, fontSize: 18 },
      h3: { fontFamily: font.semibold, fontSize: 16 },
      codespan: { fontFamily: "monospace", fontSize: 13, backgroundColor: c.muted },
      codeText: { fontFamily: "monospace", fontSize: 12.5, color: c.foreground },
      code: { backgroundColor: c.card, borderRadius: radius.md, padding: 12 },
    },
  });
  return <View style={styles.reply}>{elements}</View>;
}

function IconAction({ label, onPress, children }: { label: string; onPress: () => void; children: ReactNode }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityLabel={label}
      style={({ pressed }) => [styles.action, pressed && styles.pressed]}
    >
      {children}
    </Pressable>
  );
}

function CopyAction({ text, c }: { text: string; c: Colors }) {
  const [copied, setCopied] = useState(false);
  return (
    <IconAction
      label={copied ? "Copied" : "Copy"}
      onPress={async () => {
        await Clipboard.setStringAsync(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check size={14} color={c.mutedForeground} /> : <Copy size={14} color={c.mutedForeground} />}
    </IconAction>
  );
}

/**
 * True once a processing run has gone STALLED_RUN_MS without progress, like
 * the web's useRunStalled: it most likely died without reporting back.
 */
export const useRunStalled = (message: Doc<"messages"> | undefined) => {
  const deadline =
    message?.status === "processing"
      ? lastRunActivity(message._creationTime, message.steps ?? []) + STALLED_RUN_MS
      : undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === undefined) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [deadline]);
  return deadline !== undefined && now >= deadline;
};

/**
 * An assistant turn, like the web's AssistantMessage: the agent run, then the
 * reply once it completes, with copy, retry and restore. A plan-mode reply is
 * badged and offers "Build this plan". Text passes through sanitizeAgentText.
 */
export function AssistantMessage({
  message,
  isLast,
  pathOf,
  onOpenFile,
  onRetry,
  onRestore,
  onBuildPlan,
}: {
  message: Doc<"messages">;
  isLast: boolean;
  pathOf?: (fileId: string) => string | undefined;
  onOpenFile?: (path: string) => void;
  onRetry?: () => void;
  /** Set when a checkpoint was taken before this run. */
  onRestore?: () => void;
  onBuildPlan?: () => void;
}) {
  const c = useColors();
  const status = message.status ?? "completed";
  const steps = message.steps ?? [];
  const content = sanitizeAgentText(message.content, pathOf);
  const stalled = useRunStalled(message);
  const reduceMotion = useReducedMotion();
  // Seen running: the reply types out once it completes. History stays still.
  const [startedProcessing] = useState(status === "processing");
  const shown = useTypewriter(content, startedProcessing && !reduceMotion);
  const isPlan = message.mode === "plan";
  const meta = [
    "Codenaya",
    message.runModel?.label,
    message.completedAt && formatDuration(message.completedAt - message._creationTime),
  ]
    .filter(Boolean)
    .join(" · ");

  const restore = onRestore && status !== "processing" && (
    <IconAction label="Restore to before this run" onPress={onRestore}>
      <Undo2 size={14} color={c.mutedForeground} />
    </IconAction>
  );

  return (
    // Seen running: it settles in. A reply loaded from history stays still.
    <Animated.View entering={startedProcessing ? fadeUp() : undefined} style={styles.assistant}>
      <View style={styles.meta}>
        <Logo size={13} wordmark={false} />
        <Text style={[monoLabel, styles.flex, { color: c.mutedForeground }]} numberOfLines={1}>
          {meta}
        </Text>
      </View>
      {(status === "processing" || steps.length > 0) && (
        <AgentRun
          steps={steps}
          status={status}
          stalled={stalled}
          startedAt={message._creationTime}
          onOpenFile={onOpenFile}
        />
      )}
      {stalled && isLast && onRetry && (
        <View style={styles.stalled}>
          <Text style={[styles.stalledBadge, { color: c.destructive }]}>Taking too long</Text>
          <Pressable onPress={onRetry} style={[styles.outline, { borderColor: c.border }]}>
            <RotateCcw size={13} color={c.foreground} />
            <Text style={[styles.outlineText, { color: c.foreground }]}>Retry</Text>
          </Pressable>
        </View>
      )}
      {status === "cancelled" && steps.length === 0 && (
        <Text style={[styles.muted, { color: c.mutedForeground }]}>Request cancelled</Text>
      )}
      {/* A stopped run may still have changed files. */}
      {status === "cancelled" && restore && <View style={styles.actions}>{restore}</View>}
      {status === "completed" && content ? (
        <>
          {isPlan && (
            <View style={[styles.planBadge, { borderColor: c.border }]}>
              <ListChecks size={12} color={c.mutedForeground} />
              <Text style={[monoLabel, { color: c.mutedForeground }]}>Plan</Text>
            </View>
          )}
          <Reply content={shown} />
          {isPlan && isLast && onBuildPlan && (
            <Pressable onPress={onBuildPlan} style={[styles.build, { backgroundColor: c.brand }]}>
              <Hammer size={14} color={c.brandForeground} />
              <Text style={[monoLabel, styles.buildText, { color: c.brandForeground }]}>Build this plan</Text>
            </Pressable>
          )}
          <View style={styles.actions}>
            <CopyAction text={content} c={c} />
            {isLast && onRetry && (
              <IconAction label="Retry" onPress={onRetry}>
                <RotateCcw size={14} color={c.mutedForeground} />
              </IconAction>
            )}
            {restore}
            {restore && <Text style={[monoLabel, { color: c.mutedForeground }]}>Checkpoint saved</Text>}
          </View>
        </>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  user: { alignItems: "flex-end", gap: 8 },
  images: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 6 },
  image: { width: 80, height: 80, borderRadius: 6, borderWidth: 1 },
  bubble: { maxWidth: "88%", borderWidth: 1, borderRadius: 6, paddingHorizontal: 14, paddingVertical: 11, gap: 6 },
  skills: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  skill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  skillText: { fontSize: 12, fontFamily: font.medium },
  userText: { fontSize: 15, lineHeight: 23, fontFamily: font.regular },
  assistant: { gap: 12 },
  meta: { flexDirection: "row", alignItems: "center", gap: 8 },
  reply: { gap: 4 },
  muted: { fontSize: 14, fontFamily: font.regular },
  actions: { flexDirection: "row", alignItems: "center", gap: 14, marginTop: -4 },
  action: { padding: 2 },
  pressed: { opacity: 0.5 },
  stalled: { flexDirection: "row", alignItems: "center", gap: 8 },
  stalledBadge: {
    fontSize: 11.5,
    fontFamily: font.medium,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    overflow: "hidden",
    backgroundColor: "rgba(239, 68, 68, 0.12)",
  },
  outline: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  outlineText: { fontSize: 13, fontFamily: font.medium },
  planBadge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginBottom: -4,
  },
  build: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  buildText: { fontSize: 11, fontFamily: font.monoMedium },
});
