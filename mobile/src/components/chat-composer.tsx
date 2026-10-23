import { ArrowUp, Square } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { font, radius, useColors } from "@/lib/theme";

/**
 * The chat's message box. While the agent runs, the button stops the run
 * instead of sending, as on the web.
 */
export function ChatComposer({
  running,
  onSend,
  onStop,
}: {
  running: boolean;
  /** Resolves to an error message, or undefined once sent. */
  onSend: (text: string) => Promise<string | undefined>;
  onStop: () => Promise<void>;
}) {
  const c = useColors();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const press = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (running) {
        await onStop();
      } else {
        const failed = await onSend(text.trim());
        if (failed) setError(failed);
        else setText("");
      }
    } finally {
      setBusy(false);
    }
  };

  const enabled = !busy && (running || text.trim().length > 0);

  return (
    <View style={[styles.wrap, { borderColor: c.border, backgroundColor: c.background }]}>
      {error && <Text style={[styles.error, { color: c.destructive }]}>{error}</Text>}
      <View style={[styles.box, { backgroundColor: c.card, borderColor: c.border }]}>
        <TextInput
          style={[styles.input, { color: c.foreground }]}
          value={text}
          onChangeText={setText}
          placeholder={running ? "Codenaya is working…" : "Ask Codenaya to change something…"}
          placeholderTextColor={c.mutedForeground}
          multiline
        />
        <Pressable
          onPress={press}
          disabled={!enabled}
          accessibilityLabel={running ? "Stop" : "Send"}
          style={[styles.button, { backgroundColor: enabled ? c.primary : c.muted }]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={c.mutedForeground} />
          ) : running ? (
            <Square size={12} color={c.primaryForeground} fill={c.primaryForeground} />
          ) : (
            <ArrowUp size={16} color={enabled ? c.primaryForeground : c.mutedForeground} />
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 12, gap: 6 },
  box: { borderWidth: 1, borderRadius: radius.xl, flexDirection: "row", alignItems: "flex-end", padding: 8, gap: 8 },
  input: {
    flex: 1,
    maxHeight: 140,
    minHeight: 36,
    paddingHorizontal: 8,
    paddingVertical: 8,
    fontSize: 15,
    fontFamily: font.regular,
  },
  button: { width: 32, height: 32, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
  error: { fontSize: 13, fontFamily: font.regular, paddingHorizontal: 4 },
});
