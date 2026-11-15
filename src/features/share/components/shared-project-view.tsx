"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ChevronRightIcon, EyeIcon, GitForkIcon } from "lucide-react";
import { FileIcon, FolderIcon } from "@react-symbols/icons/utils";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { CodeEditor } from "@/features/editor/components/code-editor";
import { getItemPadding } from "@/features/projects/components/file-explorer/constants";
import { useRemix } from "@/features/showcase/hooks/use-remix";

import { childrenByParent, sharePath } from "../utils";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

export type SharedProject = NonNullable<FunctionReturnType<typeof api.projects.getShared>>;
type SharedFile = SharedProject["files"][number];

const TreeItem = ({
  file,
  level,
  tree,
  activeId,
  onOpen,
}: {
  file: SharedFile;
  level: number;
  tree: Map<Id<"files"> | null, SharedFile[]>;
  activeId: Id<"files"> | null;
  onOpen: (file: SharedFile) => void;
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const isFolder = file.type === "folder";

  return (
    <li>
      <button
        type="button"
        onClick={() => (isFolder ? setIsOpen((open) => !open) : onOpen(file))}
        aria-expanded={isFolder ? isOpen : undefined}
        className={cn(
          "flex items-center gap-1 w-full h-5.5 text-sm hover:bg-accent/30 outline-none focus:ring-1 focus:ring-inset focus:ring-ring",
          activeId === file._id && "bg-accent/30",
        )}
        style={{ paddingLeft: getItemPadding(level, !isFolder) }}
      >
        {isFolder ? (
          <>
            <ChevronRightIcon className={cn("size-4 shrink-0 text-muted-foreground", isOpen && "rotate-90")} />
            <FolderIcon folderName={file.name} className="size-4" />
          </>
        ) : (
          <FileIcon fileName={file.name} autoAssign className="size-4" />
        )}
        <span className="truncate">{file.name}</span>
      </button>
      {isFolder && isOpen && (
        <ul>
          {(tree.get(file._id) ?? []).map((child) => (
            <TreeItem key={child._id} file={child} level={level + 1} tree={tree} activeId={activeId} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </li>
  );
};

const FileContent = ({ token, file }: { token: string; file: SharedFile }) => {
  const shared = useQuery(api.projects.getSharedFile, { token, fileId: file._id });

  if (shared === undefined) {
    return (
      <div className="size-full flex items-center justify-center">
        <Spinner className="size-5 text-ring" />
      </div>
    );
  }
  if (shared === null || shared.content === null) {
    return (
      <p className="size-full flex items-center justify-center text-sm text-muted-foreground">
        {shared === null ? "This file is no longer available." : "Binary files can't be shown here."}
      </p>
    );
  }
  return <CodeEditor key={file._id} fileName={file.name} initialValue={shared.content} readOnly />;
};

/**
 * A shared project, read-only (#260): its file tree and code, who shared it,
 * and Remix into the viewer's own workspace (sign-in required). Live, so a
 * revoke hides the project at once.
 */
export const SharedProjectView = ({ token, initial }: { token: string; initial: SharedProject }) => {
  const live = useQuery(api.projects.getShared, { token });
  const project = live === undefined ? initial : live;
  const tree = useMemo(() => childrenByParent(project?.files ?? []), [project]);
  const [active, setActive] = useState<SharedFile | null>(null);

  const remixShared = useMutation(api.projects.remixShared);
  const { remix, isRemixing } = useRemix(
    sharePath(token),
    useCallback(() => remixShared({ token }), [remixShared, token]),
  );

  if (project === null) {
    return (
      <main className="h-dvh flex flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">This share link has been turned off.</p>
        <Link href="/" className="text-sm underline underline-offset-4">
          Go to Codenaya
        </Link>
      </main>
    );
  }

  return (
    <main className="h-dvh flex flex-col bg-background text-foreground">
      <header className="shrink-0 flex items-center gap-3 h-12 px-4 border-b border-border">
        <Link href="/" className="font-semibold text-sm shrink-0">
          Codenaya
        </Link>
        <div className="w-px h-4 bg-border" />
        <h1 className="text-sm font-medium truncate">{project.name}</h1>
        <span className="hidden sm:inline-flex items-center gap-1.5 text-xs text-muted-foreground truncate">
          <EyeIcon aria-hidden className="size-3.5 shrink-0" />
          Shared by {project.ownerName} · read-only
        </span>
        <Button size="sm" className="ml-auto shrink-0" onClick={remix} disabled={isRemixing}>
          <GitForkIcon aria-hidden className="size-3.5" />
          {isRemixing ? "Remixing..." : "Remix"}
        </Button>
      </header>
      <p className="sm:hidden shrink-0 px-4 py-1.5 text-xs text-muted-foreground border-b border-border">
        Shared by {project.ownerName} · read-only
      </p>
      <div className="flex-1 min-h-0 flex flex-col md:flex-row">
        <nav aria-label="Files" className="shrink-0 max-h-48 md:max-h-none md:w-64 overflow-auto border-b md:border-b-0 md:border-r border-border py-1">
          <ul>
            {(tree.get(null) ?? []).map((file) => (
              <TreeItem key={file._id} file={file} level={0} tree={tree} activeId={active?._id ?? null} onOpen={setActive} />
            ))}
          </ul>
        </nav>
        <div className="flex-1 min-h-0 min-w-0">
          {active ? (
            <FileContent token={token} file={active} />
          ) : (
            <p className="size-full flex items-center justify-center text-sm text-muted-foreground">
              Pick a file to view its code.
            </p>
          )}
        </div>
      </div>
    </main>
  );
};
