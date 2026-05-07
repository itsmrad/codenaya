import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"

import { useFile } from "@/features/projects/hooks/use-files";

import { useEditor } from "../hooks/use-editor";
import { Id } from "../../../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { FileIcon } from "@react-symbols/icons/utils";
import { XIcon } from "lucide-react";

const Tab = ({
  fileId,
  projectId,
}: {
  fileId: Id<"files">;
  projectId: Id<"projects">;
}) => {
  const file = useFile(fileId);
  const {
    activeTabId,
    previewTabId,
    setActiveTab,
    openFile,
    closeTab,
  } = useEditor(projectId);

  const isActive = activeTabId === fileId;
  const isPreview = previewTabId === fileId;
  const fileName = file?.name ?? "Loading...";

  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      onClick={() => setActiveTab(fileId)}
      onDoubleClick={() => openFile(fileId, { pinned: true })}
      className={cn(
        "flex items-center justify-center gap-2 h-8 px-3 cursor-pointer text-muted-foreground group transition-all duration-200 select-none shrink-0",
        "rounded-md text-sm font-medium",
        isActive
          ? "bg-muted text-foreground shadow-sm ring-1 ring-border/50 border border-transparent"
          : "hover:bg-muted/50 hover:text-foreground"
      )}
    >
      {file === undefined ? (
        <Spinner className="text-ring" />
      ) : (
        <FileIcon fileName={fileName} autoAssign className="size-4" />
      )}
      <span className={cn(
        "text-sm whitespace-nowrap",
        isPreview && "italic"
      )}>
        {fileName}
      </span>
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          closeTab(fileId);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            closeTab(fileId);
          }
        }}
        className={cn(
          "p-0.5 rounded-sm hover:bg-muted-foreground/20 opacity-0 group-hover:opacity-100 transition-opacity",
          isActive && "opacity-100"
        )}
      >
        <XIcon className="size-3.5" />
      </button>
    </button>
  );
};

export const TopNavigation = ({ 
  projectId
}: { 
  projectId: Id<"projects">
}) => {
  const { openTabs } = useEditor(projectId);

  return (
    <ScrollArea className="flex-1">
      <nav className="bg-background flex items-center h-12 px-2 gap-2 border-b border-border/40">
        {openTabs.map((fileId) => (
          <Tab
            key={fileId}
            fileId={fileId}
            projectId={projectId}
          />
        ))}
      </nav>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  );
};
