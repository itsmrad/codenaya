import { useMutation, useQuery } from "convex/react";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";

import type { Doc, Id } from "../../../../../convex/_generated/dataModel";
import { confirm, toast } from "@/components/dialogs";
import { monoLabel } from "@/components/grid";
import {
  Braces,
  ChevronDown,
  ChevronRight,
  File,
  FileCode,
  FilePlus2,
  FileText,
  FileType,
  Folder,
  FolderOpen,
  FolderPlus,
  type LucideIcon,
  Pencil,
  Plus,
  TextCursorInput,
  Trash2,
} from "@/components/icons";
import { NameDialog } from "@/components/name-dialog";
import { Sheet, SheetRow } from "@/components/sheet";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/format";
import { font, useColors } from "@/lib/theme";

type Dialog =
  | { kind: "new-file"; parentId?: Id<"files"> }
  | { kind: "new-folder"; parentId?: Id<"files"> }
  | { kind: "rename"; file: Doc<"files"> };

/** An icon and colour by extension, like the web's file tree. */
const ICONS: Record<string, [LucideIcon, string]> = {
  ts: [FileCode, "#3b82f6"],
  tsx: [FileCode, "#3b82f6"],
  js: [FileCode, "#3b82f6"],
  jsx: [FileCode, "#3b82f6"],
  css: [FileType, "#8b5cf6"],
  html: [FileText, "#ea580c"],
  json: [Braces, "#ca8a04"],
};

/**
 * The project's files as a tree, like the web's file explorer: folders open in
 * place, + creates a file or folder at the root, and long-press renames,
 * deletes or (on a folder) creates inside it.
 */
export default function Files() {
  const c = useColors();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const projectId = id as Id<"projects">;
  // The chat already subscribes to these, so they are usually cached.
  const project = useQuery(api.projects.getById, { id: projectId });
  const files = useQuery(api.files.getFiles, { projectId });
  const createFile = useMutation(api.files.createFile);
  const createFolder = useMutation(api.files.createFolder);
  const renameFile = useMutation(api.files.renameFile);
  const deleteFile = useMutation(api.files.deleteFile);
  const [sheet, setSheet] = useState<"new" | { file: Doc<"files"> }>();
  const [dialog, setDialog] = useState<Dialog>();
  const [expanded, setExpanded] = useState(new Set<string>());

  if (files === undefined) return <ActivityIndicator style={styles.flex} color={c.mutedForeground} />;

  // Folders first, then by name; open folders list their children below them.
  const byParent = new Map<string | undefined, Doc<"files">[]>();
  for (const file of files) byParent.set(file.parentId, [...(byParent.get(file.parentId) ?? []), file]);
  const rows: { file: Doc<"files">; depth: number }[] = [];
  const walk = (parentId: string | undefined, depth: number) => {
    const children = (byParent.get(parentId) ?? []).sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1,
    );
    for (const file of children) {
      rows.push({ file, depth });
      if (expanded.has(file._id)) walk(file._id, depth + 1);
    }
  };
  walk(undefined, 0);

  const toggle = (folderId: string) =>
    setExpanded((open) => {
      const next = new Set(open);
      if (!next.delete(folderId)) next.add(folderId);
      return next;
    });

  const open = (file: Doc<"files">, edit = false) =>
    router.push({ pathname: "/projects/[id]/file", params: { id, fileId: file._id, ...(edit ? { edit: "1" } : {}) } });

  const confirmDelete = async (file: Doc<"files">) => {
    setSheet(undefined);
    const confirmed = await confirm({
      title: `Delete ${file.name}?`,
      message: file.type === "folder" ? "This deletes the folder and everything in it." : "This deletes the file.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!confirmed) return;
    deleteFile({ id: file._id }).catch((error) => toast.error(errorMessage(error, "Couldn't delete it.")));
  };

  const saveName = async (name: string) => {
    if (!dialog) return;
    if (dialog.kind === "rename") {
      await renameFile({ id: dialog.file._id, newName: name });
    } else if (dialog.kind === "new-folder") {
      await createFolder({ projectId, parentId: dialog.parentId, name });
    } else {
      const fileId = await createFile({ projectId, parentId: dialog.parentId, name, content: "" });
      // A new file opens straight into the editor.
      router.push({ pathname: "/projects/[id]/file", params: { id, fileId, edit: "1" } });
    }
  };

  const newRows = (parentId?: Id<"files">) => (
    <>
      <SheetRow
        icon={<FilePlus2 size={18} color={c.foreground} />}
        label="New file"
        onPress={() => {
          setSheet(undefined);
          setDialog({ kind: "new-file", parentId });
        }}
      />
      <SheetRow
        icon={<FolderPlus size={18} color={c.foreground} />}
        label="New folder"
        onPress={() => {
          setSheet(undefined);
          setDialog({ kind: "new-folder", parentId });
        }}
      />
    </>
  );

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable
              onPress={() => setSheet("new")}
              accessibilityLabel="New file or folder"
              style={({ pressed }) => [styles.headerButton, pressed && { backgroundColor: c.muted }]}
            >
              <Plus size={20} color={c.foreground} />
            </Pressable>
          ),
        }}
      />
      <View style={[styles.crumb, { backgroundColor: c.card, borderColor: c.border }]}>
        <Folder size={16} color={c.mutedForeground} />
        <Text style={[styles.crumbText, { color: c.mutedForeground }]} numberOfLines={1}>
          {project?.name ?? ""} /
        </Text>
        <Text style={[monoLabel, { color: c.mutedForeground }]}>
          {files.filter((file) => file.type === "file").length} files
        </Text>
      </View>
      <FlatList
        data={rows}
        keyExtractor={({ file }) => file._id}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: c.mutedForeground }]}>
            No files yet. Ask Codenaya to build something, or tap + to add one.
          </Text>
        }
        renderItem={({ item: { file, depth } }) => {
          const isFolder = file.type === "folder";
          const isOpen = expanded.has(file._id);
          const [Icon, color] = isFolder
            ? [isOpen ? FolderOpen : Folder, c.brand]
            : (ICONS[file.name.split(".").pop() ?? ""] ?? [File, c.mutedForeground]);
          const Chevron = isOpen ? ChevronDown : ChevronRight;
          return (
            <Pressable
              style={({ pressed }) => [
                styles.row,
                { paddingLeft: 12 + depth * 18, backgroundColor: pressed ? c.muted : c.card, borderColor: c.border },
              ]}
              onPress={() => (isFolder ? toggle(file._id) : open(file))}
              onLongPress={() => setSheet({ file })}
            >
              <View style={styles.chevron}>{isFolder && <Chevron size={16} color={c.mutedForeground} />}</View>
              <Icon size={18} color={color} />
              <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
                {file.name}
              </Text>
            </Pressable>
          );
        }}
      />

      <Sheet visible={sheet === "new"} title="New in the project root" onClose={() => setSheet(undefined)}>
        {newRows()}
      </Sheet>

      <Sheet
        visible={typeof sheet === "object"}
        title={typeof sheet === "object" ? sheet.file.name : ""}
        onClose={() => setSheet(undefined)}
      >
        {typeof sheet === "object" && (
          <>
            {sheet.file.type === "folder" && newRows(sheet.file._id)}
            {sheet.file.type === "file" && !sheet.file.storageId && (
              <SheetRow
                icon={<Pencil size={18} color={c.foreground} />}
                label="Edit"
                onPress={() => {
                  setSheet(undefined);
                  open(sheet.file, true);
                }}
              />
            )}
            <SheetRow
              icon={<TextCursorInput size={18} color={c.foreground} />}
              label="Rename"
              onPress={() => {
                const file = sheet.file;
                setSheet(undefined);
                setDialog({ kind: "rename", file });
              }}
            />
            <SheetRow
              icon={<Trash2 size={18} color={c.destructive} />}
              label="Delete"
              detail={sheet.file.type === "folder" ? "This deletes the folder and everything in it." : "This deletes the file."}
              destructive
              onPress={() => confirmDelete(sheet.file)}
            />
          </>
        )}
      </Sheet>

      <NameDialog
        visible={dialog !== undefined}
        title={dialog?.kind === "rename" ? "Rename" : dialog?.kind === "new-folder" ? "New folder" : "New file"}
        initialName={dialog?.kind === "rename" ? dialog.file.name : ""}
        confirmLabel={dialog?.kind === "rename" ? "Save" : "Create"}
        placeholder={dialog?.kind === "new-folder" ? "components" : "page.tsx"}
        onClose={() => setDialog(undefined)}
        onSave={saveName}
      />
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerButton: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  crumb: { height: 36, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, borderBottomWidth: 1 },
  crumbText: { flex: 1, fontSize: 12, fontFamily: font.mono },
  row: { height: 44, flexDirection: "row", alignItems: "center", gap: 10, paddingRight: 16, borderBottomWidth: 1 },
  chevron: { width: 16 },
  name: { flex: 1, fontSize: 15, fontFamily: font.regular },
  empty: { textAlign: "center", marginTop: 48, paddingHorizontal: 24, fontSize: 14, fontFamily: font.regular },
});
