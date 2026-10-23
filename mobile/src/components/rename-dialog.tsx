import { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { font, radius, useColors } from "@/lib/theme";

// Alert.prompt is iOS-only, so renaming gets a small modal on both platforms.
export function RenameDialog({
  visible,
  initialName,
  onClose,
  onSave,
}: {
  visible: boolean;
  initialName: string;
  onClose: () => void;
  onSave: (name: string) => Promise<unknown>;
}) {
  const c = useColors();
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string>();
  const trimmed = name.trim();

  const save = async () => {
    try {
      await onSave(trimmed);
      onClose();
    } catch {
      setError("Couldn't rename the project.");
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} onShow={() => setName(initialName)}>
      <View style={styles.backdrop}>
        <View style={[styles.dialog, { backgroundColor: c.card, borderColor: c.border }]}>
          <Text style={[styles.title, { color: c.foreground }]}>Rename project</Text>
          <TextInput
            style={[styles.input, { color: c.foreground, borderColor: c.border }]}
            value={name}
            onChangeText={setName}
            onSubmitEditing={save}
            autoFocus
            selectTextOnFocus
          />
          {error && <Text style={{ color: c.destructive, fontFamily: font.regular }}>{error}</Text>}
          <View style={styles.actions}>
            <Pressable onPress={onClose} style={[styles.button, { backgroundColor: c.muted }]}>
              <Text style={[styles.buttonText, { color: c.foreground }]}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={save}
              disabled={!trimmed || trimmed === initialName}
              style={[styles.button, { backgroundColor: c.primary }, (!trimmed || trimmed === initialName) && styles.disabled]}
            >
              <Text style={[styles.buttonText, { color: c.primaryForeground }]}>Save</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", padding: 24 },
  dialog: { borderWidth: 1, borderRadius: radius.xl, padding: 20, gap: 14 },
  title: { fontSize: 17, fontFamily: font.semibold },
  input: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, fontFamily: font.regular },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  button: { borderRadius: radius.md, paddingHorizontal: 16, paddingVertical: 10 },
  buttonText: { fontSize: 14, fontFamily: font.medium },
  disabled: { opacity: 0.5 },
});
