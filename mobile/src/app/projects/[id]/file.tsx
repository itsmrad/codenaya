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
import { monoLabel } from "@/components/grid";
import { highlight } from "@/components/highlight";
import { Check, Pencil } from "@/components/icons";
import { api } from "@/lib/api";
import { font, useColors } from "@/lib/theme";

/** IBM Plex Mono's advance at the code's 12.5px, to size the gutter by digits. */
const CHAR_WIDTH = 7.5;
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
  const path = useQuery(api.files.getFilePath, { id: fileId });
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
  const statusColor = { saved: c.success, unsaved: c.mutedForeground, saving: c.mutedForeground, error: c.destructive }[
    saveState
  ];
  const gutter = String(lines.length).length * CHAR_WIDTH + 24;
  const ext = file.name.includes(".") ? file.name.split(".").pop()! : "";

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
                <Pressable
                  onPress={toggle}
                  accessibilityLabel={editing ? "Done editing" : "Edit file"}
                  style={({ pressed }) => [styles.headerButton, pressed && { backgroundColor: c.muted }]}
                >
                  {editing ? <Check size={16} color={c.foreground} /> : <Pencil size={16} color={c.foreground} />}
                  <Text style={[monoLabel, styles.headerLabel, { color: c.foreground }]}>{editing ? "Done" : "Edit"}</Text>
                </Pressable>
              ),
        }}
      />
      {/* The path, last segment strongest, and the save state. */}
      <View style={[styles.strip, styles.crumb, { backgroundColor: c.card, borderColor: c.border }]}>
        <Text style={[styles.path, { color: c.mutedForeground }]} numberOfLines={1}>
          {(path ?? []).map((segment, index, all) =>
            index < all.length - 1 ? (
              `${segment.name} / `
            ) : (
              <Text key={segment._id} style={{ color: c.foreground }}>
                {segment.name}
              </Text>
            ),
          )}
        </Text>
        {!binary && (
          <>
            <View style={[styles.dot, { backgroundColor: statusColor }]} />
            <Text style={[monoLabel, { color: statusColor }]}>{status}</Text>
          </>
        )}
      </View>
      {binary ? (
        <Text style={[styles.note, { color: c.mutedForeground }]}>
          This is a binary file (an image or similar). Open the project on the website to see it.
        </Text>
      ) : editing ? (
        <>
          <TextInput
            style={[styles.editor, styles.text, { color: c.foreground, backgroundColor: c.card }]}
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
        <>
          <View style={[styles.flex, { backgroundColor: c.card }]}>
            {/* The gutter's band runs the full height, past the last line. */}
            <View style={[styles.band, { width: gutter, backgroundColor: c.background, borderColor: c.border }]} />
            <ScrollView style={styles.flex} contentContainerStyle={styles.code}>
              {/* Line numbers stay put while the code scrolls sideways. */}
              <Text style={[styles.text, styles.numbers, { width: gutter, color: c.mutedForeground }]}>
                {lines.map((_, index) => index + 1).join("\n")}
              </Text>
              <ScrollView horizontal contentContainerStyle={styles.lines}>
                <Text style={[styles.text, { color: c.foreground }]} selectable>
                  {highlight(text, file.name, c)}
                </Text>
              </ScrollView>
            </ScrollView>
          </View>
          <View style={[styles.strip, { borderColor: c.border, paddingBottom: insets.bottom }]}>
            <Text style={[monoLabel, styles.cell, { color: c.mutedForeground, borderColor: c.border }]}>
              {ext || "Text"}
            </Text>
            <Text style={[monoLabel, styles.cell, { color: c.mutedForeground, borderColor: c.border }]}>
              {lines.length} lines
            </Text>
            <Text style={[monoLabel, styles.hint, { color: c.mutedForeground }]}>Read-only · tap Edit</Text>
          </View>
        </>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerButton: { height: 48, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16 },
  headerLabel: { fontSize: 11 },
  strip: { flexDirection: "row", alignItems: "center", borderTopWidth: 1 },
  crumb: { height: 36, gap: 8, paddingHorizontal: 16, borderTopWidth: 0, borderBottomWidth: 1 },
  path: { flex: 1, fontSize: 12, fontFamily: font.mono },
  dot: { width: 6, height: 6, borderRadius: 3 },
  band: { position: "absolute", top: 0, bottom: 0, left: 0, borderRightWidth: 1 },
  code: { flexDirection: "row", paddingVertical: 12 },
  lines: { paddingLeft: 12, paddingRight: 24 },
  text: { fontFamily: font.mono, fontSize: 12.5, lineHeight: 19 },
  numbers: { textAlign: "right", paddingRight: 12 },
  cell: { paddingHorizontal: 16, paddingVertical: 12, borderRightWidth: 1 },
  hint: { flex: 1, textAlign: "right", paddingHorizontal: 16 },
  editor: { flex: 1, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24 },
  note: { padding: 24, textAlign: "center", fontSize: 14, fontFamily: font.regular },
});
