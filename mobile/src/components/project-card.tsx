import { useMutation } from "convex/react";
import { useRouter } from "expo-router";
import { MoreHorizontal } from "lucide-react-native";
import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";

import type { Doc } from "../../../convex/_generated/dataModel";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { getCoverHue, getInitials } from "@/lib/project-cover";
import { font, radius, useColors } from "@/lib/theme";
import { RenameDialog } from "./rename-dialog";

/**
 * A project like the web's dashboard card: a cover in the project's hue, its
 * monogram, name and last edit. The menu holds rename and delete.
 */
export function ProjectCard({ project }: { project: Doc<"projects"> }) {
  const c = useColors();
  const router = useRouter();
  const rename = useMutation(api.projects.rename);
  const remove = useMutation(api.projects.remove);
  const [renaming, setRenaming] = useState(false);
  const hue = getCoverHue(project._id);

  const confirmDelete = () =>
    Alert.alert(`Delete ${project.name}?`, "This deletes the project and all its files.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => remove({ id: project._id }).catch(() => Alert.alert("Couldn't delete the project")),
      },
    ]);

  const openMenu = () =>
    Alert.alert(project.name, undefined, [
      { text: "Rename", onPress: () => setRenaming(true) },
      { text: "Delete", style: "destructive", onPress: confirmDelete },
      { text: "Cancel", style: "cancel" },
    ]);

  return (
    <Pressable
      onPress={() => router.push(`/projects/${project._id}`)}
      onLongPress={openMenu}
      style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}
    >
      <View style={[styles.cover, { backgroundColor: `hsla(${hue}, 70%, 60%, 0.14)` }]}>
        <View style={[styles.bar, styles.barTitle, { backgroundColor: `hsla(${hue}, 60%, 50%, 0.35)` }]} />
        <View style={[styles.bar, { backgroundColor: c.border }]} />
        <View style={[styles.pill, { backgroundColor: `hsl(${hue}, 60%, 58%)` }]} />
      </View>
      <View style={styles.footer}>
        <View style={[styles.monogram, { backgroundColor: `hsl(${hue}, 55%, 52%)` }]}>
          <Text style={styles.monogramText}>{getInitials(project.name)}</Text>
        </View>
        <View style={styles.text}>
          <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
            {project.name}
          </Text>
          <Text style={[styles.meta, { color: c.mutedForeground }]}>
            Edited {timeAgo(project.updatedAt)}
          </Text>
        </View>
        <Pressable onPress={openMenu} hitSlop={10} accessibilityLabel="Project actions">
          <MoreHorizontal size={18} color={c.mutedForeground} />
        </Pressable>
      </View>
      <RenameDialog
        visible={renaming}
        initialName={project.name}
        onClose={() => setRenaming(false)}
        onSave={(name) => rename({ id: project._id, name })}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.xl, overflow: "hidden" },
  cover: { aspectRatio: 16 / 10, alignItems: "center", paddingTop: "8%", gap: 8 },
  bar: { height: 6, width: "40%", borderRadius: 3 },
  barTitle: { height: 10, width: "60%", borderRadius: 5 },
  pill: { height: 12, width: "20%", borderRadius: 6, marginTop: 4 },
  footer: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  monogram: { width: 28, height: 28, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  monogramText: { color: "#fff", fontSize: 10, fontFamily: font.semibold },
  text: { flex: 1, minWidth: 0 },
  name: { fontSize: 14, fontFamily: font.medium },
  meta: { fontSize: 12, fontFamily: font.regular, marginTop: 1 },
});
