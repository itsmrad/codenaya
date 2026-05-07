import { useState } from "react"
import { ChevronRightIcon, CopyMinusIcon, FilePlusCornerIcon, FolderPlusIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"

import { useProject } from "../../hooks/use-projects"
import { Id } from "../../../../../convex/_generated/dataModel"
import { 
  useCreateFile,
  useCreateFolder,
  useFolderContents
} from "../../hooks/use-files"
import { CreateInput } from "./create-input"
import { LoadingRow } from "./loading-row"
import { Tree } from "./tree"

export const FileExplorer = ({ 
  projectId
}: { 
  projectId: Id<"projects">
}) => {
  const [isOpen, setIsOpen] = useState(true);
  const [collapseKey, setCollapseKey] = useState(0);
  const [creating, setCreating] = useState<"file" | "folder" | null>(
    null
  );

  const project = useProject(projectId);
  const rootFiles = useFolderContents({
    projectId,
    enabled: isOpen,
  });

  const createFile = useCreateFile();
  const createFolder = useCreateFolder();
  const handleCreate = (name: string) => {
    setCreating(null);

    if (creating === "file") {
      createFile({
        projectId,
        name,
        content: "",
        parentId: undefined,
      });
    } else {
      createFolder({
        projectId,
        name,
        parentId: undefined,
      });
    }
  };

  return (
    <div className="h-full bg-background flex flex-col">
      <div className="p-2 shrink-0 border-b border-border/40">
        <div
          role="button"
          onClick={() => setIsOpen((value) => !value)}
          className="group/project cursor-pointer w-full text-left flex items-center justify-between px-2 h-10 bg-muted/40 hover:bg-muted/60 transition-colors rounded-lg border border-border/50"
        >
          <div className="flex items-center gap-1.5 overflow-hidden">
            <ChevronRightIcon
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
                isOpen && "rotate-90"
              )}
            />
            <p className="text-sm font-semibold uppercase tracking-wide truncate">
              {project?.name ?? "Loading..."}
            </p>
          </div>
          <div className="opacity-0 group-hover/project:opacity-100 transition-opacity duration-200 flex items-center gap-0.5 shrink-0">
            <Button
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setIsOpen(true);
                setCreating("file");
              }}
              variant="ghost"
              size="icon"
              className="size-7 hover:bg-muted"
            >
              <FilePlusCornerIcon className="size-3.5" />
            </Button>
            <Button
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setIsOpen(true);
                setCreating("folder");
              }}
              variant="ghost"
              size="icon"
              className="size-7 hover:bg-muted"
            >
              <FolderPlusIcon className="size-3.5" />
            </Button>
            <Button
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setCollapseKey((prev) => prev + 1);
              }}
              variant="ghost"
              size="icon"
              className="size-7 hover:bg-muted"
            >
              <CopyMinusIcon className="size-3.5" />
            </Button>
          </div>
        </div>
      </div>
      <ScrollArea className="flex-1 py-2">
        {isOpen && (
          <div className="px-1.5">
            {rootFiles === undefined && <LoadingRow level={0} />}
            {creating && (
              <CreateInput
                type={creating}
                level={0}
                onSubmit={handleCreate}
                onCancel={() => setCreating(null)}
              />
            )}
            {rootFiles?.map((item) => (
              <Tree
                key={`${item._id}-${collapseKey}`}
                item={item}
                level={0}
                projectId={projectId}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}