import { StyleSheet, Text, View } from "react-native";
import { useMarkdown } from "react-native-marked";

import type { Doc } from "../../../convex/_generated/dataModel";
import { AgentRun } from "@/components/agent-run";
import { sanitizeAgentText } from "@/lib/shared";
import { font, radius, useColors } from "@/lib/theme";

/** The user's message: a muted bubble on the right, like the web. */
export function UserMessage({ content }: { content: string }) {
  const c = useColors();
  return (
    <View style={[styles.bubble, { backgroundColor: c.muted }]}>
      <Text style={[styles.userText, { color: c.foreground }]}>{content}</Text>
    </View>
  );
}

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

/**
 * An assistant turn, like the web's AssistantMessage: the agent run, then the
 * reply once it completes. Text passes through the web's sanitizeAgentText.
 */
export function AssistantMessage({
  message,
  pathOf,
  onOpenFile,
}: {
  message: Doc<"messages">;
  pathOf?: (fileId: string) => string | undefined;
  onOpenFile?: (path: string) => void;
}) {
  const c = useColors();
  const status = message.status ?? "completed";
  const steps = message.steps ?? [];
  const content = sanitizeAgentText(message.content, pathOf);

  return (
    <View style={styles.assistant}>
      {(status === "processing" || steps.length > 0) && (
        <AgentRun
          steps={steps}
          status={status}
          startedAt={message._creationTime}
          completedAt={message.completedAt}
          model={message.runModel?.label}
          onOpenFile={onOpenFile}
        />
      )}
      {status === "cancelled" && steps.length === 0 && (
        <Text style={[styles.muted, { color: c.mutedForeground }]}>Request cancelled</Text>
      )}
      {status === "completed" && content ? <Reply content={content} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    alignSelf: "flex-end",
    maxWidth: "88%",
    borderRadius: 18,
    borderBottomRightRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  userText: { fontSize: 14, lineHeight: 22, fontFamily: font.regular },
  assistant: { gap: 12 },
  reply: { gap: 4 },
  muted: { fontSize: 14, fontFamily: font.regular },
});
