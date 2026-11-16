import { useContext, useRef, useState } from "react";

import { ChevronRightIcon } from "lucide-react";
import { FileIcon, FolderIcon } from "@react-symbols/icons/utils";

import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { convexErrorMessage } from "@/lib/convex-error";

import {
  useCreateFile,
  useCreateFolder,
  useFolderContents,
  useRenameFile,
  useDeleteFile,
  isOptimisticFileId,
} from "@/features/projects/hooks/use-files";
import { useEditor } from "@/features/editor/hooks/use-editor";
import { undoAction, useRestoreCheckpoint } from "@/features/conversations/hooks/use-checkpoints";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

import { entryFocusKey, focusEntryWhenMounted, ExplorerFocusContext, useExplorerFocusTarget } from "./focus";
import { nextFocusAfterDelete } from "./next-focus";
import { getItemPadding } from "./constants";
import { LoadingRow } from "./loading-row";
import { CreateInput } from "./create-input";
import { RenameInput } from "./rename-input";
import { TreeItemWrapper } from "./tree-item-wrapper";
import { Doc, Id } from "../../../../../convex/_generated/dataModel";

export const Tree = ({
  item,
  siblings,
  level = 0,
  projectId,
  lockedAbove = false,
}: {
  item: Doc<"files">;
  siblings: Doc<"files">[];
  level?: number;
  projectId: Id<"projects">;
  /** A folder above this item is locked from AI edits (#307). */
  lockedAbove?: boolean;
}) => {
  const { requestFocus } = useContext(ExplorerFocusContext)!;
  const rowRef = useExplorerFocusTarget(item._id);
  const deleteFocus = useRef<string | null | undefined>(undefined);
  const [isOpen, setIsOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [creating, setCreating] = useState<"file" | "folder" | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const renameFile = useRenameFile({
    projectId,
    parentId: item.parentId,
  });
  const deleteFile = useDeleteFile({
    projectId,
    parentId: item.parentId,
  });
  const restore = useRestoreCheckpoint();
  const createFile = useCreateFile();
  const createFolder = useCreateFolder();

  const { openFile, closeTab, activeTabId } = useEditor(projectId);

  const folderContents = useFolderContents({
    projectId,
    parentId: item._id,
    enabled: item.type === "folder" && isOpen,
  });

  const handleRename = async (newName: string) => {
    setIsRenaming(false);
    requestFocus(item._id);

    if (newName === item.name) {
      return;
    }

    try {
      await renameFile({ id: item._id, newName });
    } catch (error) {
      toast.error(convexErrorMessage(error, `Couldn't rename ${item.name}`));
    }
  };

  const handleCreate = async (name: string) => {
    const createType = creating;
    setCreating(null);
    requestFocus(item._id);

    // Validate against siblings in folderContents
    if (folderContents) {
      const exists = folderContents.some(
        (f) => f.name === name && f.type === createType
      );
      if (exists) {
        toast.error(createType === "file" ? "File already exists" : "Folder already exists");
        return;
      }
    }

    try {
      if (createType === "file") {
        const fileId = await createFile({
          projectId,
          name,
          content: "",
          parentId: item._id,
        });
        // Open the confirmed id, never the optimistic one (#266).
        if (fileId) openFile(fileId, { pinned: false });
        focusEntryWhenMounted(entryFocusKey(item._id, name));
      } else if (createType === "folder") {
        await createFolder({
          projectId,
          name,
          parentId: item._id,
        });
        focusEntryWhenMounted(entryFocusKey(item._id, name));
      }
    } catch (error) {
      toast.error(convexErrorMessage(error, `Couldn't create the ${createType}`));
    }
  };

  const startCreating =(type: "file" | "folder") => {
    setIsOpen(true);
    setCreating(type);
  };

  // #259: confirm first, and offer Undo, which restores the snapshot the
  // delete took.
  const handleDelete = () => {
    deleteFocus.current = nextFocusAfterDelete(siblings, item._id);
    setConfirmingDelete(false);
    deleteFile({ id: item._id }).then(
      // Null when the project is too big to snapshot: no Undo then.
      (undoCheckpointId) => {
        // Close the tab only once the file is really gone, so a failed delete
        // doesn't leave the user without the tab of a file that still exists.
        if (item.type === "file") closeTab(item._id);
        toast.success(`Deleted ${item.name}`, {
          action: undoCheckpointId
            ? undoAction(() =>
                restore({ checkpointId: undoCheckpointId }).then(
                  () => toast.success(`Restored ${item.name}`),
                  (error) => toast.error(convexErrorMessage(error, "Couldn't undo the delete")),
                ),
              )
            : undefined,
        });
      },
      (error) => {
        deleteFocus.current = item._id;
        requestFocus(item._id);
        toast.error(convexErrorMessage(error, `Couldn't delete ${item.name}`));
      },
    );
  };

  const deleteDialog = (
    <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
      <AlertDialogContent onCloseAutoFocus={(event) => {
        // The optimistic delete can unmount this dialog before its exit finishes.
        event.preventDefault();
        requestFocus(deleteFocus.current === undefined ? item._id : deleteFocus.current);
      }}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {item.type === "folder"
              ? `Delete "${item.name}" and everything in it?`
              : `Delete "${item.name}"?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            You can undo this right after, or restore it from Version history.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  if (item.type === "file") {
    const fileName = item.name;
    const isActive = activeTabId === item._id;

    if (isRenaming) {
      return (
        <RenameInput
          type="file"
          defaultValue={fileName}
          level={level}
          onSubmit={handleRename}
          onCancel={() => { setIsRenaming(false); requestFocus(item._id); }}
        />
      );
    }

    return (
      <>
      <TreeItemWrapper
        item={item}
        lockedAbove={lockedAbove}
        level={level}
        isActive={isActive}
        onClick={() => {
          if (!isOptimisticFileId(item._id)) {
            openFile(item._id, { pinned: false });
          }
        }}
        onDoubleClick={() => {
          if (!isOptimisticFileId(item._id)) {
            openFile(item._id, { pinned: true });
          }
        }}
        onRename={() => setIsRenaming(true)}
        onDelete={() => { deleteFocus.current = undefined; setConfirmingDelete(true); }}
      >
        <FileIcon fileName={fileName} autoAssign className="size-4" />
        <span className="truncate text-sm" title={fileName}>{fileName}</span>
      </TreeItemWrapper>
      {deleteDialog}
      </>
    )
  }

  const folderName = item.name;

  const folderRender = (
    <>
      <div className="flex items-center gap-0.5">
        <ChevronRightIcon
          className={cn(
            "size-4 shrink-0 text-muted-foreground",
            isOpen && "rotate-90"
          )}
        />
        <FolderIcon folderName={folderName} className="size-4" />
      </div>
      <span className="truncate text-sm" title={folderName}>{folderName}</span>
    </>
  )

  if (creating) {
    return (
      <>
        <button
          ref={rowRef}
          onClick={() => setIsOpen((value) => !value)}
          className="group flex items-center gap-1 h-5.5 hover:bg-accent/30 w-full"
          style={{ paddingLeft: getItemPadding(level, false) }}
        >
          {folderRender}
        </button>
        {isOpen && (
          <>
            {folderContents === undefined && <LoadingRow level={level + 1} />}
            <CreateInput
              type={creating}
              level={level + 1}
              onSubmit={handleCreate}
              onCancel={() => { setCreating(null); requestFocus(item._id); }}
            />
            {folderContents?.map((subItem) => (
              <Tree
                key={subItem._id}
                item={subItem}
                siblings={folderContents}
                level={level + 1}
                lockedAbove={lockedAbove || item.locked === true}
                projectId={projectId}
              />
            ))}
          </>
        )}
      </>
    )
  }

  if (isRenaming) {
    return (
      <>
        <RenameInput
          type="folder"
          defaultValue={folderName}
          isOpen={isOpen}
          level={level}
          onSubmit={handleRename}
          onCancel={() => { setIsRenaming(false); requestFocus(item._id); }}
        />
        {isOpen && (
          <>
            {folderContents === undefined && <LoadingRow level={level + 1} />}
            {folderContents?.map((subItem) => (
              <Tree
                key={subItem._id}
                item={subItem}
                siblings={folderContents}
                level={level + 1}
                lockedAbove={lockedAbove || item.locked === true}
                projectId={projectId}
              />
            ))}
          </>
        )}
      </>
    )
  }

  return (
    <>
      <TreeItemWrapper
        item={item}
        lockedAbove={lockedAbove}
        level={level}
        onClick={() => setIsOpen((value) => !value)}
        onRename={() => setIsRenaming(true)}
        onDelete={() => { deleteFocus.current = undefined; setConfirmingDelete(true); }}
        onCreateFile={() => startCreating("file")}
        onCreateFolder={() => startCreating("folder")}
      >
        {folderRender}
      </TreeItemWrapper>
      {deleteDialog}
      {isOpen && (
        <>
          {folderContents === undefined && <LoadingRow level={level + 1} />}
          {folderContents?.map((subItem) => (
            <Tree
              key={subItem._id}
              item={subItem}
              siblings={folderContents}
              level={level + 1}
              lockedAbove={lockedAbove || item.locked === true}
              projectId={projectId}
            />
          ))}
        </>
      )}
    </>
  );
};
