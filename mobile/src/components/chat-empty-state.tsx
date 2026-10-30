import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";

import { Corners, monoLabel } from "@/components/grid";
import { CornerDownRight } from "@/components/icons";
import { Logo } from "@/components/logo";
import { fadeUp } from "@/lib/motion";
import { font, useColors } from "@/lib/theme";

// The first three of the web's SUGGESTIONS (chat-empty-state.tsx), to keep the card compact.
const SUGGESTIONS = [
  "Add a landing page with a hero and pricing section",
  "Restyle the app with a clean, minimal dark theme",
  "Find and fix bugs in the current code",
];

/**
 * Start of a new conversation, like the web: a short intro and prompts sent in
 * one tap. The prompts hide while typing, when the keyboard leaves no room.
 */
export function ChatEmptyState({ onSelect, typing }: { onSelect: (prompt: string) => void; typing?: boolean }) {
  const c = useColors();
  return (
    <View style={styles.wrap}>
      {/* A grid window, as on sign-in: `+` corners outside the card. */}
      <View>
        <Corners />
        <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
          <Logo size={22} wordmark={false} />
          <Text style={[styles.title, { color: c.foreground }]}>What do you want to build?</Text>
          <Text style={[styles.subtitle, { color: c.mutedForeground }]}>Codenaya edits your project files directly.</Text>
          {!typing && (
            <>
              <Text style={[monoLabel, styles.try, { color: c.mutedForeground }]}>[ Try ]</Text>
              <View style={[styles.list, { borderColor: c.border }]}>
                {SUGGESTIONS.map((prompt, index) => (
                  <Animated.View key={prompt} entering={fadeUp({ delay: index * 90 })}>
                    <Pressable
                      onPress={() => onSelect(prompt)}
                      style={({ pressed }) => [
                        styles.suggestion,
                        { borderColor: c.border },
                        index > 0 && styles.rule,
                        pressed && { backgroundColor: c.muted },
                      ]}
                    >
                      <CornerDownRight size={15} color={c.brandText} />
                      <Text style={[styles.prompt, { color: c.foreground }]}>{prompt}</Text>
                    </Pressable>
                  </Animated.View>
                ))}
              </View>
            </>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: "center", paddingHorizontal: 20, paddingVertical: 16 },
  card: {
    borderWidth: 1,
    borderRadius: 6,
    padding: 16,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 2,
  },
  title: { marginTop: 12, fontSize: 18, fontFamily: font.semibold, letterSpacing: -0.3 },
  subtitle: { marginTop: 4, fontSize: 13, fontFamily: font.regular },
  try: { marginTop: 14, marginBottom: 8 },
  list: { borderWidth: 1, borderRadius: 6, overflow: "hidden" },
  suggestion: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 10 },
  rule: { borderTopWidth: 1 },
  prompt: { flex: 1, fontSize: 13, lineHeight: 18, fontFamily: font.regular },
});
