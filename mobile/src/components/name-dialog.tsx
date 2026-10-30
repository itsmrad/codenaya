import { useState } from "react";
import { KeyboardAvoidingView, Modal, StyleSheet, Text, TextInput, View } from "react-native";

import { DialogCard } from "@/components/dialogs";
import { Button } from "@/components/form";
import { errorMessage } from "@/lib/format";
import { font, useColors } from "@/lib/theme";

// Alert.prompt is iOS-only, so naming (rename, new file or folder) gets a
// small modal on both platforms, in the confirm dialog's window.
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
  const [focused, setFocused] = useState(false);
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
        <DialogCard
          label="Name"
          title={title}
          actions={
            <>
              <View style={styles.action}>
                <Button label="Cancel" variant="outline" onPress={onClose} />
              </View>
              <View style={styles.action}>
                <Button label={confirmLabel} variant="brand" onPress={save} disabled={!trimmed || trimmed === initialName} />
              </View>
            </>
          }
        >
          <TextInput
            style={[styles.input, { color: c.foreground, borderColor: focused ? c.brand : c.border, backgroundColor: c.background }]}
            value={name}
            onChangeText={setName}
            onSubmitEditing={save}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={placeholder}
            placeholderTextColor={c.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            selectTextOnFocus
          />
          {error && <Text style={[styles.error, { color: c.destructive }]}>{error}</Text>}
        </DialogCard>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 24 },
  input: { height: 44, marginTop: 6, borderWidth: 1, borderRadius: 6, paddingHorizontal: 12, fontSize: 15, fontFamily: font.regular },
  error: { fontSize: 13, fontFamily: font.regular },
  action: { flex: 1 },
});
