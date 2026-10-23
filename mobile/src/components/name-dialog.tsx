import { useState } from "react";
import { KeyboardAvoidingView, Modal, StyleSheet, Text, TextInput, View } from "react-native";
import Animated from "react-native-reanimated";

import { Button } from "@/components/form";
import { errorMessage } from "@/lib/format";
import { zoomIn } from "@/lib/motion";
import { font, radius, useColors } from "@/lib/theme";

// Alert.prompt is iOS-only, so naming (rename, new file or folder) gets a
// small modal on both platforms.
export function NameDialog({
  visible,
  title,
  initialName = "",
  confirmLabel = "Save",
  placeholder,
  onClose,
  onSave,
}: {
  visible: boolean;
  title: string;
  initialName?: string;
  confirmLabel?: string;
  placeholder?: string;
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
    } catch (error) {
      setError(errorMessage(error));
    }
  };

  return (
    // Translucent bars, so the backdrop covers the whole screen like the confirm dialog's.
    <Modal visible={visible} transparent statusBarTranslucent navigationBarTranslucent animationType="fade" onRequestClose={onClose} onShow={() => {
        setName(initialName);
        setError(undefined);
      }}>
      {/* Lifts the dialog above the keyboard its input opens. */}
      <KeyboardAvoidingView behavior="padding" style={styles.backdrop}>
        <Animated.View entering={zoomIn} style={[styles.dialog, { backgroundColor: c.card, borderColor: c.border }]}>
          <Text style={[styles.title, { color: c.foreground }]}>{title}</Text>
          <TextInput
            style={[styles.input, { color: c.foreground, borderColor: c.border }]}
            value={name}
            onChangeText={setName}
            onSubmitEditing={save}
            placeholder={placeholder}
            placeholderTextColor={c.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            selectTextOnFocus
          />
          {error && <Text style={{ color: c.destructive, fontFamily: font.regular }}>{error}</Text>}
          <View style={styles.actions}>
            <View style={styles.action}>
              <Button label="Cancel" variant="outline" onPress={onClose} />
            </View>
            <View style={styles.action}>
              <Button label={confirmLabel} onPress={save} disabled={!trimmed || trimmed === initialName} />
            </View>
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 24 },
  dialog: { borderWidth: 1, borderRadius: radius.xl, padding: 20, gap: 14 },
  title: { fontSize: 17, fontFamily: font.semibold },
  input: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, fontFamily: font.regular },
  actions: { flexDirection: "row", gap: 8, marginTop: 4 },
  action: { flex: 1 },
});
