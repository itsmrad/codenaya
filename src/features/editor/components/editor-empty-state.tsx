"use client";

import { BookOpenIcon, EyeIcon, FileIcon } from "lucide-react";

import { CodenayaLogo } from "@/components/codenaya-logo";
import { Button } from "@/components/ui/button";
import { useConversations, useMessages } from "@/features/conversations/hooks/use-conversations";
import { useFiles } from "@/features/projects/hooks/use-files";
import { useCommandPalette } from "@/lib/command-palette";

import { useEditor } from "../hooks/use-editor";
import { recentlyChangedFiles } from "../recently-changed";
import { Id } from "../../../../convex/_generated/dataModel";

/**
 * The editor with no file open (#315): next steps instead of a dead end. The
 * files the last run wrote and the root README open in a tab, and "Open preview" runs the same action as the
 * Preview tab (registered for the command palette by ProjectIdView).
 */
export const EditorEmptyState = ({ projectId }: { projectId: Id<"projects"> }) => {
  const files = useFiles(projectId);
  const { openFile } = useEditor(projectId);
  const showPreview = useCommandPalette((state) => state.commands["show-preview"]);
  // The newest conversation's last run: its recorded steps are what the chat card shows.
  const conversations = useConversations(projectId);
  const messages = useMessages(conversations?.[0]?._id ?? null);
  const lastRun = messages?.findLast((message) => message.role === "assistant" && message.steps?.length);
  const recent = recentlyChangedFiles(lastRun?.steps ?? [], files ?? []);
  const readme = files?.find(
    (file) => file.type === "file" && !file.parentId && file.name.toLowerCase() === "readme.md",
  );

  return (
    <div className="size-full flex flex-col items-center justify-center gap-4 p-6 text-center">
      <CodenayaLogo size={40} blinking={true} className="opacity-30" />
      <p className="text-xs text-muted-foreground">Pick a file in the explorer, or:</p>
      {recent.length > 0 && (
        <div className="flex flex-col items-center gap-1.5">
          <p className="text-xs text-muted-foreground">Recently changed</p>
          <div className="flex flex-wrap justify-center gap-2">
            {recent.map(({ file, path }) => (
              <Button
                key={file._id}
                variant="outline"
                size="sm"
                title={path}
                onClick={() => openFile(file._id, { pinned: true })}
              >
                <FileIcon className="size-3.5" />
                {file.name}
              </Button>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        {readme && (
          <Button variant="outline" size="sm" onClick={() => openFile(readme._id, { pinned: true })}>
            <BookOpenIcon className="size-3.5" />
            Open README.md
          </Button>
        )}
        {showPreview && (
          <Button variant="outline" size="sm" onClick={showPreview}>
            <EyeIcon className="size-3.5" />
            Open preview
          </Button>
        )}
      </div>
    </div>
  );
};
