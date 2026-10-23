import { useMutation, useQuery } from "convex/react";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useHeaderHeight } from "expo-router/react-navigation";

import type { Id } from "../../../../../convex/_generated/dataModel";
import { api } from "@/lib/api";
import { font, useColors } from "@/lib/theme";

const MONO = "monospace";
/** Same autosave delay as the web editor (editor-view.tsx). */
const DEBOUNCE_MS = 1500;

type SaveState = "saved" | "unsaved" | "saving" | "error";

/**
 * One file: read-only with line numbers, live as the agent edits it, or, with
 * Edit, a code editor that autosaves like the web's.
 */
export default function FileView() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const params = useLocalSearchParams<{ fileId: string; edit?: string }>();
  const fileId = params.fileId as Id<"files">;
  const file = useQuery(api.files.getFile, { id: fileId });
  const updateFile = useMutation(api.files.updateFile);

  const [editing, setEditing] = useState(params.edit === "1");
  const [draft, setDraft] = useState<string>();
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pending = useRef<string | undefined>(undefined);

  const save = async () => {
    clearTimeout(timer.current);
    const content = pending.current;
    if (content === undefined) return;
    pending.current = undefined;
    setSaveState("saving");
    try {
      await updateFile({ id: fileId, content });
      // Typing during the save leaves it unsaved.
      setSaveState(pending.current === undefined ? "saved" : "unsaved");
    } catch {
      pending.current ??= content;
      setSaveState("error");
    }
  };

  // Leaving the screen saves what is still waiting out the debounce.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (pending.current !== undefined) updateFile({ id: fileId, content: pending.current }).catch(() => undefined);
    },
    [fileId, updateFile],
  );

  if (file === undefined) return <ActivityIndicator style={styles.flex} color={c.mutedForeground} />;

  const binary = Boolean(file.storageId);
  // While editing, the local draft wins over agent updates (as on the web).
  const text = editing ? (draft ?? file.content ?? "") : (file.content ?? "");
  const lines = text.split("\n");

  const onChange = (value: string) => {
    setDraft(value);
    pending.current = value;
    setSaveState("unsaved");
    clearTimeout(timer.current);
    timer.current = setTimeout(save, DEBOUNCE_MS);
  };

  const toggle = async () => {
    if (editing) {
      await save();
      setDraft(undefined);
    } else {
      setDraft(file.content ?? "");
    }
    setEditing(!editing);
  };

  const status = { saved: "Saved", unsaved: "Unsaved", saving: "Saving…", error: "Save failed, retrying on next edit" }[saveState];

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      // Android draws edge to edge, so the window no longer resizes for the
      // keyboard: pad on both platforms, below the header.
      behavior="padding"
      keyboardVerticalOffset={headerHeight}
    >
      <Stack.Screen
        options={{
          title: file.name,
          headerRight: binary
            ? undefined
            : () => (
                <Pressable onPress={toggle} hitSlop={10} accessibilityLabel={editing ? "Done editing" : "Edit file"}>
                  <Text style={[styles.headerButton, { color: c.brandText }]}>{editing ? "Done" : "Edit"}</Text>
                </Pressable>
              ),
        }}
      />
      {binary ? (
        <Text style={[styles.note, { color: c.mutedForeground }]}>
          This is a binary file (an image or similar). Open the project on the website to see it.
        </Text>
      ) : editing ? (
        <>
          <View style={[styles.statusBar, { borderColor: c.border }]}>
            <Text style={[styles.status, { color: saveState === "error" ? c.destructive : c.mutedForeground }]}>
              {status}
            </Text>
            <Text style={[styles.status, { color: c.mutedForeground }]}>{lines.length} lines</Text>
          </View>
          <TextInput
            style={[styles.editor, styles.text, { color: c.foreground }]}
            value={text}
            onChangeText={onChange}
            multiline
            autoFocus={params.edit === "1"}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            textAlignVertical="top"
            // Plain keys for code: no smart quotes or dashes.
            keyboardType={Platform.OS === "ios" ? "ascii-capable" : "visible-password"}
            scrollEnabled
          />
        </>
      ) : (
        <ScrollView style={styles.flex}>
          <ScrollView horizontal contentContainerStyle={styles.code}>
            <View style={[styles.gutter, { borderColor: c.border }]}>
              <Text style={[styles.text, styles.numbers, { color: c.mutedForeground }]}>
                {lines.map((_, index) => index + 1).join("\n")}
              </Text>
            </View>
            <Text style={[styles.text, { color: c.foreground }]} selectable>
              {text}
            </Text>
          </ScrollView>
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerButton: { fontSize: 15, fontFamily: font.medium },
  code: { paddingVertical: 12, paddingRight: 24 },
  gutter: { borderRightWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, marginRight: 12 },
  text: { fontFamily: MONO, fontSize: 12.5, lineHeight: 19 },
  numbers: { textAlign: "right" },
  statusBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  status: { fontSize: 12, fontFamily: font.regular },
  editor: { flex: 1, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24 },
  note: { padding: 24, textAlign: "center", fontSize: 14, fontFamily: font.regular },
});
