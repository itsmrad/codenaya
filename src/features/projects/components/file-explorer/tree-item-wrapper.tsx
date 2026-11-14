import { useMutation } from "convex/react";
import { LockIcon } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { convexErrorMessage } from "@/lib/convex-error";
import { isOptimisticFileId } from "@/features/projects/hooks/use-files";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuContent,
  ContextMenuTrigger,
  ContextMenuShortcut,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";

import { getItemPadding } from "./constants";
import { api } from "../../../../../convex/_generated/api";
import { Doc } from "../../../../../convex/_generated/dataModel";

export const TreeItemWrapper = ({
  item,
  children,
  level,
  isActive,
  onClick,
  onDoubleClick,
  onRename,
  onDelete,
  onCreateFile,
  onCreateFolder,
}: {
  item: Doc<"files">;
  children: React.ReactNode;
  level: number;
  isActive?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  onCreateFile?: () => void;
  onCreateFolder?: () => void;
}) => {
  const setLocked = useMutation(api.files.setLocked);
  // #307: locks stop AI edits only; the user can still edit by hand.
  const toggleLock = () =>
    setLocked({ id: item._id, locked: !item.locked }).catch((error) =>
      toast.error(convexErrorMessage(error, "Couldn't change the lock")),
    );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onRename?.();
            }
          }}
          className={cn(
            "group flex items-center gap-1 w-full h-5.5 hover:bg-accent/30 outline-none focus:ring-1 focus:ring-inset focus:ring-ring",
            isActive && "bg-accent/30",
          )}
          style={{ paddingLeft: getItemPadding(level, item.type === "file") }}
        >
          {children}
          {item.locked && (
            <LockIcon aria-label="Locked from AI edits" className="ml-auto mr-2 size-3 shrink-0 text-muted-foreground" />
          )}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent
        onCloseAutoFocus={(e) => e.preventDefault()}
        className="w-64"
      >
        {item.type === "folder" && (
          <>
            <ContextMenuItem 
              onClick={onCreateFile}
              className="text-sm"
            >
              New File...
            </ContextMenuItem>
            <ContextMenuItem 
              onClick={onCreateFolder}
              className="text-sm"
            >
              New Folder...
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
         <ContextMenuItem 
          onClick={onRename}
          className="text-sm"
        >
          Rename...
          <ContextMenuShortcut>
            Enter
          </ContextMenuShortcut>
        </ContextMenuItem>
         <ContextMenuItem 
          onClick={onDelete}
          className="text-sm"
        >
          Delete...
        </ContextMenuItem>
        {!isOptimisticFileId(item._id) && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={toggleLock} className="text-sm">
              {item.locked ? "Unlock" : "Lock from AI"}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
};
