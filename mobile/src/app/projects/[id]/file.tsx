import { useQuery } from "convex/react";
import { Stack, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";

import type { Id } from "../../../../../convex/_generated/dataModel";
import { api } from "@/lib/api";
import { font, useColors } from "@/lib/theme";

const MONO = "monospace";

/** A read-only view of one file, with line numbers. Updates live as the agent edits it. */
export default function FileView() {
  const c = useColors();
  const { fileId } = useLocalSearchParams<{ fileId: string }>();
  const file = useQuery(api.files.getFile, { id: fileId as Id<"files"> });

  if (file === undefined) return <ActivityIndicator style={styles.flex} />;

  const lines = (file.content ?? "").split("\n");

  return (
    <>
      <Stack.Screen options={{ title: file.name }} />
      {file.storageId ? (
        <Text style={[styles.note, { color: c.mutedForeground }]}>
          This is a binary file (an image or similar). Open the project on the website to see it.
        </Text>
      ) : (
        <ScrollView style={styles.flex}>
          <ScrollView horizontal contentContainerStyle={styles.code}>
            <View style={[styles.gutter, { borderColor: c.border }]}>
              <Text style={[styles.text, styles.numbers, { color: c.mutedForeground }]}>
                {lines.map((_, index) => index + 1).join("\n")}
              </Text>
            </View>
            <Text style={[styles.text, { color: c.foreground }]} selectable>
              {file.content}
            </Text>
          </ScrollView>
        </ScrollView>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  code: { paddingVertical: 12, paddingRight: 24 },
  gutter: { borderRightWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, marginRight: 12 },
  text: { fontFamily: MONO, fontSize: 12.5, lineHeight: 19 },
  numbers: { textAlign: "right" },
  note: { padding: 24, textAlign: "center", fontSize: 14, fontFamily: font.regular },
});
