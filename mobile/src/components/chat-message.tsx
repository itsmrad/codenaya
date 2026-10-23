import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { BookOpen, Check, Copy, Hammer, ListChecks, RotateCcw, Undo2 } from "lucide-react-native";
import { type ReactNode, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useMarkdown } from "react-native-marked";
import Animated, { useReducedMotion } from "react-native-reanimated";

import type { Doc } from "../../../convex/_generated/dataModel";
import { AgentRun } from "@/components/agent-run";
import { fadeUp } from "@/lib/motion";
import { STALLED_RUN_MS, lastRunActivity, sanitizeAgentText, splitSlashSkills } from "@/lib/shared";
import { type Colors, font, radius, useColors } from "@/lib/theme";

/**
 * The user's message, like the web: images above a muted bubble on the right.
 * Leading `/name` tokens that name an enabled skill show as chips.
 */
export function UserMessage({
  content,
  imageUrls = [],
  skillNames,
  animate = false,
}: {
  content: string;
  imageUrls?: string[];
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
      {imageUrls.length > 0 && (
        <View style={styles.images}>
          {imageUrls.map((url) => (
            <Image key={url} source={url} style={[styles.image, { borderColor: c.border }]} contentFit="cover" />
          ))}
        </View>
      )}
      {(text.trim() || skills.length > 0) && (
        <View style={[styles.bubble, { backgroundColor: c.muted }]}>
          {skills.length > 0 && (
            <View style={styles.skills}>
              {skills.map((name) => (
                <View key={name} style={[styles.skill, { borderColor: c.border, backgroundColor: c.background }]}>
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
  const elements = useMarkdown(content, {
    colorScheme: "dark",
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

  const restore = onRestore && status !== "processing" && (
    <IconAction label="Restore to before this run" onPress={onRestore}>
      <Undo2 size={14} color={c.mutedForeground} />
    </IconAction>
  );

  return (
    // Seen running: it settles in. A reply loaded from history stays still.
    <Animated.View entering={startedProcessing ? fadeUp() : undefined} style={styles.assistant}>
      {(status === "processing" || steps.length > 0) && (
        <AgentRun
          steps={steps}
          status={status}
          stalled={stalled}
          startedAt={message._creationTime}
          completedAt={message.completedAt}
          model={message.runModel?.label}
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
              <Text style={[styles.planText, { color: c.mutedForeground }]}>Plan</Text>
            </View>
          )}
          <Reply content={shown} />
          {isPlan && isLast && onBuildPlan && (
            <Pressable onPress={onBuildPlan} style={[styles.build, { backgroundColor: c.primary }]}>
              <Hammer size={14} color={c.primaryForeground} />
              <Text style={[styles.buildText, { color: c.primaryForeground }]}>Build this plan</Text>
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
          </View>
        </>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  user: { alignItems: "flex-end", gap: 6 },
  images: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 6 },
  image: { width: 80, height: 80, borderRadius: radius.lg, borderWidth: 1 },
  bubble: {
    maxWidth: "88%",
    borderRadius: 18,
    borderBottomRightRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 6,
  },
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
  userText: { fontSize: 14, lineHeight: 22, fontFamily: font.regular },
  assistant: { gap: 12 },
  reply: { gap: 4 },
  muted: { fontSize: 14, fontFamily: font.regular },
  actions: { flexDirection: "row", gap: 14, marginTop: -4 },
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
    borderRadius: radius.sm,
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
  planText: { fontSize: 12, fontFamily: font.medium },
  build: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  buildText: { fontSize: 13, fontFamily: font.medium },
});
