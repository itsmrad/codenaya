import { useEffect, useState } from "react";

import { useFile } from "@/features/projects/hooks/use-files";

import { FileEditor } from "./file-editor";
import { EditorSession } from "../editor-session";
import { EditorEmptyState } from "./editor-empty-state";
import { useEditor } from "../hooks/use-editor";
import { TopNavigation } from "./top-navigation";
import { FileBreadcrumbs } from "./file-breadcrumbs";
import { Id } from "../../../../convex/_generated/dataModel";
import { AlertTriangleIcon } from "lucide-react";

export const EditorView = ({ projectId }: { projectId: Id<"projects"> }) => {
  const { activeTabId } = useEditor(projectId);
  const activeFile = useFile(activeTabId);
  // Keep drafts across tab switches, including conflicts awaiting the user's choice.
  const [sessions] = useState(() => new Map<Id<"files">, EditorSession>());

  const isActiveFileBinary = activeFile && activeFile.storageId;
  const isActiveFileText = activeFile && !activeFile.storageId;

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      for (const session of sessions.values()) {
        const state = session.getSnapshot();
        if (!state.dirty && !state.saving && !state.conflict) continue;
        void session.save();
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [sessions]);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center">
        <TopNavigation projectId={projectId} />
      </div>
      {activeTabId && <FileBreadcrumbs projectId={projectId} />}
      <div className="flex-1 min-h-0 bg-background">
        {!activeFile && <EditorEmptyState projectId={projectId} />}
        {isActiveFileText && (
          <FileEditor key={activeFile._id} file={activeFile} sessions={sessions} />
        )}
        {isActiveFileBinary && (
          <div className="size-full flex items-center justify-center">
            <div className="flex flex-col items-center gap-2.5 max-w-md text-center">
              <AlertTriangleIcon className="size-10 text-yellow-500" />
              <p className="text-sm">
                The file is not displayed in the text editor because it is either binary or uses an unsupported text encoding.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
