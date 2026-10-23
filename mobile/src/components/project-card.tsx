import * as Clipboard from "expo-clipboard";
import { useConvex, useMutation } from "convex/react";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { CircleAlert, Copy, Download, ExternalLink, GitBranch, Link, MoreHorizontal, Pencil, Trash2 } from "lucide-react-native";
import { type ReactNode, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";

import type { Doc } from "../../../convex/_generated/dataModel";
import { api } from "@/lib/api";
import { errorMessage, timeAgo } from "@/lib/format";
import { webUrl } from "@/lib/http";
import { PULSE } from "@/lib/motion";
import { getCoverHue, getInitials } from "@/lib/project-cover";
import { shareProjectZip } from "@/lib/project-zip";
import { type Colors, font, radius, useColors } from "@/lib/theme";
import { NameDialog } from "./name-dialog";
import { Sheet, SheetRow } from "./sheet";

/** The web card's status pill: importing, import failed, or linked to GitHub. */
function StatusBadge({ project, c }: { project: Doc<"projects">; c: Colors }) {
  let content: ReactNode = null;
  if (project.importStatus === "importing") {
    content = (
      <>
        <Animated.View style={[styles.dot, { backgroundColor: c.brand }, PULSE]} />
        <Text style={[styles.badgeText, { color: c.foreground }]}>Importing…</Text>
      </>
    );
  } else if (project.importStatus === "failed") {
    content = (
      <>
        <CircleAlert size={11} color={c.destructive} />
        <Text style={[styles.badgeText, { color: c.destructive }]}>Import failed</Text>
      </>
    );
  } else if (project.importStatus === "completed" || project.exportStatus === "completed") {
    content = (
      <>
        <GitBranch size={11} color={c.mutedForeground} />
        <Text style={[styles.badgeText, { color: c.mutedForeground }]}>GitHub</Text>
      </>
    );
  }
  return content ? (
    <View style={[styles.badge, { backgroundColor: c.background, borderColor: c.border }]}>{content}</View>
  ) : null;
}

/**
 * A project like the web's dashboard card: a cover in the project's hue, its
 * monogram, name, last edit and status. The menu holds the web card's link
 * actions plus duplicate, download, rename and delete.
 */
export function ProjectCard({ project }: { project: Doc<"projects"> }) {
  const c = useColors();
  const router = useRouter();
  const convex = useConvex();
  const rename = useMutation(api.projects.rename);
  const duplicate = useMutation(api.projects.duplicate);
  const remove = useMutation(api.projects.remove);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const hue = getCoverHue(project._id);
  const link = webUrl(`/projects/${project._id}`);

  // Each action closes the menu first, so alerts and dialogs aren't hidden behind it.
  const act = (action: () => void) => () => {
    setMenuOpen(false);
    action();
  };

  const confirmDelete = () =>
    Alert.alert(`Delete ${project.name}?`, "This deletes the project and all its files.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => remove({ id: project._id }).catch(() => Alert.alert("Couldn't delete the project")),
      },
    ]);

  return (
    <Pressable
      onPress={() => router.push(`/projects/${project._id}`)}
      onLongPress={() => setMenuOpen(true)}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: c.card, borderColor: c.border },
        pressed && styles.pressed,
      ]}
    >
      <View style={[styles.cover, { backgroundColor: `hsla(${hue}, 70%, 60%, 0.14)` }]}>
        <View style={[styles.bar, styles.barTitle, { backgroundColor: `hsla(${hue}, 60%, 50%, 0.35)` }]} />
        <View style={[styles.bar, { backgroundColor: c.border }]} />
        <View style={[styles.pill, { backgroundColor: `hsl(${hue}, 60%, 58%)` }]} />
        <StatusBadge project={project} c={c} />
      </View>
      <View style={styles.footer}>
        <View style={[styles.monogram, { backgroundColor: `hsl(${hue}, 55%, 52%)` }]}>
          <Text style={styles.monogramText}>{getInitials(project.name)}</Text>
        </View>
        <View style={styles.text}>
          <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
            {project.name}
          </Text>
          <Text style={[styles.meta, { color: c.mutedForeground }]}>Edited {timeAgo(project.updatedAt)}</Text>
        </View>
        <Pressable onPress={() => setMenuOpen(true)} hitSlop={10} accessibilityLabel="Project actions">
          <MoreHorizontal size={18} color={c.mutedForeground} />
        </Pressable>
      </View>

      <Sheet visible={menuOpen} title={project.name} onClose={() => setMenuOpen(false)}>
        <SheetRow
          label="Open on the website"
          trailing={<ExternalLink size={16} color={c.mutedForeground} />}
          onPress={act(() => WebBrowser.openBrowserAsync(link))}
        />
        <SheetRow
          label="Copy link"
          trailing={<Link size={16} color={c.mutedForeground} />}
          onPress={act(async () => {
            await Clipboard.setStringAsync(link);
            Alert.alert("Link copied");
          })}
        />
        <SheetRow
          label="Duplicate"
          detail="Files, settings and project skills; not chats or secrets"
          trailing={<Copy size={16} color={c.mutedForeground} />}
          onPress={act(() =>
            duplicate({ id: project._id }).catch((error) => Alert.alert(errorMessage(error, "Couldn't duplicate the project"))),
          )}
        />
        <SheetRow
          label="Download ZIP"
          trailing={<Download size={16} color={c.mutedForeground} />}
          onPress={act(() =>
            shareProjectZip(convex, project._id, project.name).catch(() => Alert.alert("Couldn't create the ZIP")),
          )}
        />
        <SheetRow
          label="Rename"
          trailing={<Pencil size={16} color={c.mutedForeground} />}
          onPress={act(() => setRenaming(true))}
        />
        <SheetRow label="Delete" trailing={<Trash2 size={16} color={c.destructive} />} onPress={act(confirmDelete)} />
      </Sheet>
      <NameDialog
        visible={renaming}
        title="Rename project"
        initialName={project.name}
        onClose={() => setRenaming(false)}
        onSave={(name) => rename({ id: project._id, name })}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.xl, overflow: "hidden" },
  pressed: { opacity: 0.85, transform: [{ scale: 0.99 }] },
  cover: { aspectRatio: 16 / 10, alignItems: "center", paddingTop: "8%", gap: 8 },
  bar: { height: 6, width: "40%", borderRadius: 3 },
  barTitle: { height: 10, width: "60%", borderRadius: 5 },
  pill: { height: 12, width: "20%", borderRadius: 6, marginTop: 4 },
  badge: {
    position: "absolute",
    top: 10,
    left: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeText: { fontSize: 11, fontFamily: font.medium },
  dot: { width: 6, height: 6, borderRadius: 3 },
  footer: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  monogram: { width: 28, height: 28, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  monogramText: { color: "#fff", fontSize: 10, fontFamily: font.semibold },
  text: { flex: 1, minWidth: 0 },
  name: { fontSize: 14, fontFamily: font.medium },
  meta: { fontSize: 12, fontFamily: font.regular, marginTop: 1 },
});
