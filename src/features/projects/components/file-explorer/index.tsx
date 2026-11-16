import { useEffect, useRef, useContext, useState } from "react"
import { ChevronRightIcon, CopyMinusIcon, FilePlusCornerIcon, FolderPlusIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { toast } from "sonner"
import { convexErrorMessage } from "@/lib/convex-error"

import { useProject } from "../../hooks/use-projects"
import { Id } from "../../../../../convex/_generated/dataModel"
import { 
  useCreateFile,
  useCreateFolder,
  useFolderContents
} from "../../hooks/use-files"
import { useEditor } from "@/features/editor/hooks/use-editor";
import { CreateInput } from "./create-input"
import { LoadingRow } from "./loading-row"
import { Tree } from "./tree"
import { entryFocusKey, createEntryFocusRequest, focusEntryWhenMounted, ExplorerFocusContext, useExplorerFocusController, useExplorerFocusTarget } from "./focus"

export const FileExplorer = ({ projectId }: { projectId: Id<"projects"> }) => {
  const focus = useExplorerFocusController();
  return (
    <ExplorerFocusContext.Provider value={focus}>
      <FileExplorerContents projectId={projectId} />
    </ExplorerFocusContext.Provider>
  );
};

const FileExplorerContents = ({ projectId }: { projectId: Id<"projects"> }) => {
  const { requestFocus } = useContext(ExplorerFocusContext)!;
  const createButtonRef = useExplorerFocusTarget(null);
  const createFocus = useRef<AbortController | null>(null);
  useEffect(() => () => createFocus.current?.abort(), []);
  const [isOpen, setIsOpen] = useState(true);
  const [collapseKey, setCollapseKey] = useState(0);
  const [creating, setCreating] = useState<"file" | "folder" | null>(
    null
  );

  const { openFile } = useEditor(projectId);
  const project = useProject(projectId);
  const rootFiles = useFolderContents({
    projectId,
    enabled: isOpen,
  });

  const createFile = useCreateFile();
  const createFolder = useCreateFolder();
  const handleCreate = async (name: string, restoreFocus: boolean) => {
    const focusRequest = createEntryFocusRequest(restoreFocus);
    createFocus.current = focusRequest;
    const createType = creating;
    setCreating(null);

    // Validate against siblings in rootFiles
    if (rootFiles) {
      const exists = rootFiles.some(
        (f) => f.name === name && f.type === createType
      );
      if (exists) {
        if (!focusRequest.signal.aborted) requestFocus(null);
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
          parentId: undefined,
        });
        // Open the confirmed id, never the optimistic one (#266).
        if (fileId) openFile(fileId, { pinned: false });
        focusEntryWhenMounted(entryFocusKey(undefined, name), { signal: focusRequest.signal });
      } else if (createType === "folder") {
        await createFolder({
          projectId,
          name,
          parentId: undefined,
        });
        focusEntryWhenMounted(entryFocusKey(undefined, name), { signal: focusRequest.signal });
      }
    } catch (error) {
      if (!focusRequest.signal.aborted) requestFocus(null);
      toast.error(convexErrorMessage(error, `Couldn't create the ${createType}`));
    }
  };

  return (
    <div data-testid="file-explorer" className="h-full bg-background flex flex-col">
      <div className="p-2 shrink-0 border-b border-border/40">
        <div className="group/project relative w-full text-left flex items-center justify-between px-2 h-10 bg-muted/40 hover:bg-muted/60 transition-colors rounded-lg border border-border/50">
          <button
            type="button"
            aria-expanded={isOpen}
            onClick={() => setIsOpen((value) => !value)}
            className="flex items-center gap-1.5 overflow-hidden flex-1 text-left min-w-0 cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded py-1"
          >
            <ChevronRightIcon
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
                isOpen && "rotate-90"
              )}
            />
            <p
              className="text-sm font-semibold uppercase tracking-wide truncate"
              title={project?.name}
            >
              {project?.name ?? "Loading..."}
            </p>
          </button>
          {/* From md up the actions overlay the name until hover/focus, so they take no width. */}
          <div className="opacity-100 md:opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity duration-200 flex items-center gap-0.5 shrink-0 md:absolute md:right-1.5 md:top-1/2 md:-translate-y-1/2 md:rounded-md md:bg-[color-mix(in_oklab,var(--muted)_60%,var(--background))]">
            <Button
              ref={createButtonRef}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setIsOpen(true);
                setCreating("file");
              }}
              variant="ghost"
              size="icon"
              className="size-7 hover:bg-muted"
              aria-label="Create file"
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
              aria-label="Create folder"
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
              aria-label="Collapse all"
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
                onCancel={(restoreFocus) => { setCreating(null); if (restoreFocus) requestFocus(null); }}
              />
            )}
            {rootFiles?.length === 0 && !creating && (
              <p role="status" className="px-2 py-1 text-sm text-muted-foreground">
                No files yet. Use Create file above.
              </p>
            )}
            {rootFiles?.map((item) => (
              <Tree
                key={`${item._id}-${collapseKey}`}
                item={item}
                siblings={rootFiles}
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