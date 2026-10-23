import { useMutation, useQuery } from "convex/react";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { ChevronRight, File, FilePlus2, Folder, FolderPlus, Pencil, Plus, Trash2 } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";

import type { Doc, Id } from "../../../../../convex/_generated/dataModel";
import { confirm, toast } from "@/components/dialogs";
import { NameDialog } from "@/components/name-dialog";
import { Sheet, SheetRow } from "@/components/sheet";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/format";
import { font, useColors } from "@/lib/theme";

type Dialog = { kind: "new-file" } | { kind: "new-folder" } | { kind: "rename"; file: Doc<"files"> };

/**
 * One folder of the project (the root when `folder` is unset), like the web's
 * file explorer: subfolders push another of these screens, + creates a file or
 * folder here, and long-press renames or deletes.
 */
export default function Files() {
  const c = useColors();
  const router = useRouter();
  const { id, folder } = useLocalSearchParams<{ id: string; folder?: string }>();
  const projectId = id as Id<"projects">;
  const parentId = (folder || undefined) as Id<"files"> | undefined;
  // The chat already subscribes to this, so it is usually cached.
  const files = useQuery(api.files.getFiles, { projectId });
  const createFile = useMutation(api.files.createFile);
  const createFolder = useMutation(api.files.createFolder);
  const renameFile = useMutation(api.files.renameFile);
  const deleteFile = useMutation(api.files.deleteFile);
  const [sheet, setSheet] = useState<"new" | { file: Doc<"files"> }>();
  const [dialog, setDialog] = useState<Dialog>();

  if (files === undefined) return <ActivityIndicator style={styles.flex} color={c.mutedForeground} />;

  const current = parentId ? files.find((file) => file._id === parentId) : undefined;
  const entries = files
    .filter((file) => (file.parentId ?? undefined) === parentId)
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1));

  const open = (file: Doc<"files">, edit = false) =>
    router.push(
      file.type === "folder"
        ? { pathname: "/projects/[id]/files", params: { id, folder: file._id } }
        : { pathname: "/projects/[id]/file", params: { id, fileId: file._id, ...(edit ? { edit: "1" } : {}) } },
    );

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
      await createFolder({ projectId, parentId, name });
    } else {
      const fileId = await createFile({ projectId, parentId, name, content: "" });
      // A new file opens straight into the editor.
      router.push({ pathname: "/projects/[id]/file", params: { id, fileId, edit: "1" } });
    }
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: current?.name ?? "Files",
          headerRight: () => (
            <Pressable onPress={() => setSheet("new")} hitSlop={10} accessibilityLabel="New file or folder">
              <Plus size={20} color={c.mutedForeground} />
            </Pressable>
          ),
        }}
      />
      <FlatList
        data={entries}
        keyExtractor={(file) => file._id}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: c.mutedForeground }]}>
            {parentId ? "This folder is empty." : "No files yet. Ask Codenaya to build something, or tap + to add one."}
          </Text>
        }
        ItemSeparatorComponent={() => <View style={[styles.separator, { backgroundColor: c.border }]} />}
        renderItem={({ item }) => {
          const isFolder = item.type === "folder";
          return (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.muted }]}
              onPress={() => open(item)}
              onLongPress={() => setSheet({ file: item })}
            >
              {isFolder ? <Folder size={18} color={c.brand} /> : <File size={18} color={c.mutedForeground} />}
              <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
                {item.name}
              </Text>
              {isFolder && <ChevronRight size={16} color={c.mutedForeground} />}
            </Pressable>
          );
        }}
      />

      <Sheet visible={sheet === "new"} title={`New in ${current?.name ?? "the project root"}`} onClose={() => setSheet(undefined)}>
        <SheetRow
          label="New file"
          trailing={<FilePlus2 size={16} color={c.mutedForeground} />}
          onPress={() => {
            setSheet(undefined);
            setDialog({ kind: "new-file" });
          }}
        />
        <SheetRow
          label="New folder"
          trailing={<FolderPlus size={16} color={c.mutedForeground} />}
          onPress={() => {
            setSheet(undefined);
            setDialog({ kind: "new-folder" });
          }}
        />
      </Sheet>

      <Sheet
        visible={typeof sheet === "object"}
        title={typeof sheet === "object" ? sheet.file.name : ""}
        onClose={() => setSheet(undefined)}
      >
        {typeof sheet === "object" && (
          <>
            {sheet.file.type === "file" && !sheet.file.storageId && (
              <SheetRow
                label="Edit"
                trailing={<Pencil size={16} color={c.mutedForeground} />}
                onPress={() => {
                  setSheet(undefined);
                  open(sheet.file, true);
                }}
              />
            )}
            <SheetRow
              label="Rename"
              trailing={<Pencil size={16} color={c.mutedForeground} />}
              onPress={() => {
                const file = sheet.file;
                setSheet(undefined);
                setDialog({ kind: "rename", file });
              }}
            />
            <SheetRow
              label="Delete"
              destructive
              trailing={<Trash2 size={16} color={c.destructive} />}
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
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  name: { flex: 1, fontSize: 15, fontFamily: font.regular },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 46 },
  empty: { textAlign: "center", marginTop: 48, paddingHorizontal: 24, fontSize: 14, fontFamily: font.regular },
});
