import { useQuery } from "convex/react";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { ChevronRight, File, Folder } from "lucide-react-native";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";

import type { Id } from "../../../../../convex/_generated/dataModel";
import { api } from "@/lib/api";
import { font, useColors } from "@/lib/theme";

/**
 * One folder of the project (the root when `folder` is unset). Subfolders
 * push another of these screens, so back walks up the tree.
 */
export default function Files() {
  const c = useColors();
  const router = useRouter();
  const { id, folder } = useLocalSearchParams<{ id: string; folder?: string }>();
  const projectId = id as Id<"projects">;
  // The chat already subscribes to this, so it is usually cached.
  const files = useQuery(api.files.getFiles, { projectId });

  if (files === undefined) return <ActivityIndicator style={styles.flex} />;

  const current = folder ? files.find((file) => file._id === folder) : undefined;
  const entries = files
    .filter((file) => (file.parentId ?? undefined) === (folder || undefined))
    .sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1,
    );

  return (
    <>
      <Stack.Screen options={{ title: current?.name ?? "Files" }} />
      <FlatList
        data={entries}
        keyExtractor={(file) => file._id}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: c.mutedForeground }]}>
            {folder ? "This folder is empty." : "No files yet. Ask Codenaya to build something."}
          </Text>
        }
        ItemSeparatorComponent={() => <View style={[styles.separator, { backgroundColor: c.border }]} />}
        renderItem={({ item }) => {
          const isFolder = item.type === "folder";
          return (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.muted }]}
              onPress={() =>
                router.push(
                  isFolder
                    ? { pathname: "/projects/[id]/files", params: { id, folder: item._id } }
                    : { pathname: "/projects/[id]/file", params: { id, fileId: item._id } },
                )
              }
            >
              {isFolder ? (
                <Folder size={18} color={c.brand} />
              ) : (
                <File size={18} color={c.mutedForeground} />
              )}
              <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
                {item.name}
              </Text>
              {isFolder && <ChevronRight size={16} color={c.mutedForeground} />}
            </Pressable>
          );
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  name: { flex: 1, fontSize: 15, fontFamily: font.regular },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 46 },
  empty: { textAlign: "center", marginTop: 48, paddingHorizontal: 24, fontSize: 14, fontFamily: font.regular },
});
