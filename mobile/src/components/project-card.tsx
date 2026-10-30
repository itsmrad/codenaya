import * as Clipboard from "expo-clipboard";
import { useConvex, useMutation } from "convex/react";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { type ReactNode, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";

import type { Doc } from "../../../convex/_generated/dataModel";
import {
  CircleAlert,
  Copy,
  Download,
  EllipsisVertical,
  ExternalLink,
  Link,
  Pencil,
  Trash2,
} from "@/components/icons";
import { api } from "@/lib/api";
import { errorMessage, timeAgo } from "@/lib/format";
import { webUrl } from "@/lib/http";
import { PULSE } from "@/lib/motion";
import { shareProjectZip } from "@/lib/project-zip";
import { type Colors, font, useColors } from "@/lib/theme";
import { confirm, toast } from "./dialogs";
import { GitHubIcon } from "./github-icon";
import { monoLabel } from "./grid";
import { NameDialog } from "./name-dialog";
import { ProjectCover } from "./project-cover";
import { Sheet, SheetRow } from "./sheet";

/** The web card's status pill: importing, import failed, or linked to GitHub. */
function StatusBadge({ project, c }: { project: Doc<"projects">; c: Colors }) {
  let content: ReactNode = null;
  if (project.importStatus === "importing") {
    // Unboxed, in the brand colour, so it reads as live rather than a tag.
    return (
      <View style={styles.importing}>
        <Animated.View style={[styles.dot, { backgroundColor: c.brand }, PULSE]} />
        <Text style={[monoLabel, styles.badgeText, { color: c.brandText }]}>Importing…</Text>
      </View>
    );
  } else if (project.importStatus === "failed") {
    content = (
      <>
        <CircleAlert size={11} color={c.destructive} />
        <Text style={[monoLabel, styles.badgeText, { color: c.destructive }]}>Import failed</Text>
      </>
    );
  } else if (project.importStatus === "completed" || project.exportStatus === "completed") {
    content = (
      <>
        <GitHubIcon size={11} color={c.mutedForeground} />
        <Text style={[monoLabel, styles.badgeText, { color: c.mutedForeground }]}>GitHub</Text>
      </>
    );
  }
  return content ? <View style={[styles.badge, { borderColor: c.border }]}>{content}</View> : null;
}

/**
 * A project row: its cover, name, last edit and the web card's status pill. The
 * menu holds the web card's link actions plus duplicate, download, rename and delete.
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
  const link = webUrl(`/projects/${project._id}`);

  // Each action closes the menu first, so the rename dialog isn't hidden behind it.
  const act = (action: () => void) => () => {
    setMenuOpen(false);
    action();
  };

  const confirmDelete = async () => {
    const confirmed = await confirm({
      title: `Delete “${project.name}”?`,
      message: "This deletes the project and all its files. This can't be undone.",
      confirmLabel: "Delete project",
      destructive: true,
    });
    if (!confirmed) return;
    remove({ id: project._id }).then(
      () => toast.success(`Deleted “${project.name}”`),
      () => toast.error("Couldn't delete the project"),
    );
  };

  return (
    <Pressable
      onPress={() => router.push(`/projects/${project._id}`)}
      onLongPress={() => setMenuOpen(true)}
      style={({ pressed }) => pressed && { backgroundColor: c.muted }}
    >
      <View style={styles.row}>
        <View style={[styles.thumb, { borderColor: c.border }]}>
          <ProjectCover seed={project._id} style={StyleSheet.absoluteFill} />
        </View>
        <View style={styles.text}>
          <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
            {project.name}
          </Text>
          <View style={styles.metaRow}>
            <Text style={[monoLabel, styles.meta, { color: c.mutedForeground }]}>Edited {timeAgo(project.updatedAt)}</Text>
            <StatusBadge project={project} c={c} />
          </View>
        </View>
        <Pressable onPress={() => setMenuOpen(true)} hitSlop={10} accessibilityLabel="Project actions">
          <EllipsisVertical size={16} color={c.mutedForeground} />
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
            toast.success("Link copied");
          })}
        />
        <SheetRow
          label="Duplicate"
          detail="Files, settings and project skills; not chats or secrets"
          trailing={<Copy size={16} color={c.mutedForeground} />}
          onPress={act(() =>
            duplicate({ id: project._id }).then(
              () => toast.success("Project duplicated"),
              (error) => toast.error(errorMessage(error, "Couldn't duplicate the project")),
            ),
          )}
        />
        <SheetRow
          label="Download ZIP"
          trailing={<Download size={16} color={c.mutedForeground} />}
          onPress={act(() =>
            shareProjectZip(convex, project._id, project.name).catch(() => toast.error("Couldn't create the ZIP")),
          )}
        />
        <SheetRow
          label="Rename"
          trailing={<Pencil size={16} color={c.mutedForeground} />}
          onPress={act(() => setRenaming(true))}
        />
        <SheetRow label="Delete" destructive trailing={<Trash2 size={16} color={c.destructive} />} onPress={act(confirmDelete)} />
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
  thumb: { width: 44, height: 44, borderRadius: 4, borderWidth: 1, overflow: "hidden" },
  text: { flex: 1, minWidth: 0, gap: 4 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  meta: { fontSize: 9.5 },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1,
    borderRadius: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeText: { fontSize: 9 },
  importing: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  name: { fontSize: 15, fontFamily: font.medium },
});
