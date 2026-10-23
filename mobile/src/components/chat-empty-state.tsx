import { ArrowUpRight, Bug, Database, LayoutTemplate, Palette, Sparkles } from "lucide-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";

import { fadeUp } from "@/lib/motion";
import { font, radius, useColors } from "@/lib/theme";

// The web's SUGGESTIONS (chat-empty-state.tsx).
const SUGGESTIONS = [
  { icon: LayoutTemplate, prompt: "Add a landing page with a hero and pricing section" },
  { icon: Palette, prompt: "Restyle the app with a clean, minimal dark theme" },
  { icon: Bug, prompt: "Find and fix bugs in the current code" },
  { icon: Database, prompt: "Add a todo list that saves to localStorage" },
];

/** Start of a new conversation, like the web: a short intro and prompts sent in one tap. */
export function ChatEmptyState({ onSelect }: { onSelect: (prompt: string) => void }) {
  const c = useColors();
  return (
    <View style={styles.wrap}>
      <View style={[styles.badge, { backgroundColor: c.muted }]}>
        <Sparkles size={16} color={c.brand} />
      </View>
      <Text style={[styles.title, { color: c.foreground }]}>What do you want to build?</Text>
      <Text style={[styles.subtitle, { color: c.mutedForeground }]}>Codenaya edits your project files directly.</Text>
      <View style={styles.list}>
        {SUGGESTIONS.map(({ icon: Icon, prompt }, index) => (
          <Animated.View key={prompt} entering={fadeUp({ delay: index * 90 })}>
            <Pressable
              onPress={() => onSelect(prompt)}
              style={({ pressed }) => [
                styles.suggestion,
                { borderColor: c.border },
                pressed && { backgroundColor: c.muted },
              ]}
            >
              <Icon size={16} color={c.mutedForeground} />
              <Text style={[styles.prompt, { color: c.foreground }]}>{prompt}</Text>
              <ArrowUpRight size={14} color={c.mutedForeground} />
            </Pressable>
          </Animated.View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: "center", paddingHorizontal: 16, paddingVertical: 24 },
  badge: { width: 36, height: 36, borderRadius: radius.lg, alignItems: "center", justifyContent: "center" },
  title: { marginTop: 12, fontSize: 16, fontFamily: font.medium },
  subtitle: { fontSize: 14, fontFamily: font.regular },
  list: { marginTop: 20, gap: 8 },
  suggestion: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  prompt: { flex: 1, fontSize: 13.5, lineHeight: 19, fontFamily: font.regular },
});
