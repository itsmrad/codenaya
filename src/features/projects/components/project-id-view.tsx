"use client";

import { useState } from "react";
import { Allotment } from "allotment";
import Link from "next/link";
import { CloudCheckIcon, LoaderIcon, PlugIcon } from "lucide-react";
import { UserButton } from "@clerk/nextjs";
import { formatDistanceToNow } from "date-fns";

import { cn } from "@/lib/utils";
import { EditorView } from "@/features/editor/components/editor-view";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { FileExplorer } from "./file-explorer";
import { Id } from "../../../../convex/_generated/dataModel";
import { PreviewView } from "./preview-view";
import { ExportPopover } from "./export-popover";
import { useProject, useRenameProject } from "../hooks/use-projects";
import { PublishDialog } from "@/features/showcase/components/publish-dialog";
import { useIsProjectPublished } from "@/features/showcase/hooks/use-showcase";
import { IntegrationsDialog } from "@/features/integrations/components/integrations-dialog";

const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 800;
const DEFAULT_SIDEBAR_WIDTH = 350;
const DEFAULT_MAIN_SIZE = 1000;

const Tab = ({
  label,
  isActive,
  onClick,
}: {
  label: string;
  isActive: boolean;
  onClick: () => void;
}) => {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      onClick={onClick}
      className={cn(
        "flex items-center justify-center px-3 py-1 cursor-pointer transition-all duration-200 select-none",
        "rounded-md text-xs font-medium",
        isActive
          ? "bg-background text-foreground shadow-sm ring-1 ring-border/60"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
      )}
    >
      {label}
    </button>
  );
};

export const ProjectIdView = ({
  projectId,
}: {
  projectId: Id<"projects">;
}) => {
  const [activeView, setActiveView] = useState<"editor" | "preview">("editor");
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);
  const [integrationsDialogOpen, setIntegrationsDialogOpen] = useState(false);
  const project = useProject(projectId);
  const renameProject = useRenameProject();
  const isPublished = useIsProjectPublished(projectId);

  const [isRenaming, setIsRenaming] = useState(false);
  const [name, setName] = useState("");

  const handleStartRename = () => {
    if (!project) return;
    setName(project.name);
    setIsRenaming(true);
  };

  const handleSubmit = () => {
    if (!project) return;
    setIsRenaming(false);

    const trimmedName = name.trim();
    if (!trimmedName || trimmedName === project.name) return;

    renameProject({ id: projectId, name: trimmedName });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSubmit();
    } else if (e.key === "Escape") {
      setIsRenaming(false);
    }
  };

  return (
    <>
      <PublishDialog
        open={publishDialogOpen}
        onOpenChange={setPublishDialogOpen}
        projectId={projectId}
        projectName={project?.name ?? ""}
      />
      <IntegrationsDialog
        open={integrationsDialogOpen}
        onOpenChange={setIntegrationsDialogOpen}
      />
    <div className="h-full flex flex-col gap-2">
      {/* ─── Unified Navbar ─── */}
      <nav className="shrink-0 h-11 flex items-center gap-3 px-3 rounded-xl bg-card border border-border/60 shadow-[0_1px_3px_rgba(0,0,0,0.12),0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-[0_1px_3px_rgba(0,0,0,0.4),0_0_0_1px_rgba(255,255,255,0.03)]">
        {/* Left: Brand + Project Name + Save */}
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          {/* Brand */}
          <Link href="/" className="flex items-center gap-2 shrink-0 group">
            <img
              src="/logo-alt.svg"
              alt="Codenaya"
              className="size-4.5 dark:invert-0 invert transition-transform duration-200 group-hover:rotate-12"
            />
            <span className="text-xs font-semibold tracking-tight text-foreground hidden sm:inline">
              codenaya
            </span>
          </Link>

          {/* Separator */}
          <div className="w-px h-4 bg-border/50 shrink-0" />

          {/* Project Name */}
          {isRenaming ? (
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={handleSubmit}
              onKeyDown={handleKeyDown}
              className="text-xs bg-transparent text-foreground outline-none focus:ring-1 focus:ring-brand/40 focus:ring-inset rounded px-1 py-0.5 font-medium max-w-44 truncate"
            />
          ) : (
            <button
              onClick={handleStartRename}
              className="text-xs font-medium text-foreground/80 hover:text-foreground truncate max-w-44 transition-colors"
            >
              {project?.name ?? "Loading..."}
            </button>
          )}

          {/* Save status */}
          {project?.importStatus === "importing" ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <LoaderIcon className="size-3 text-muted-foreground animate-spin shrink-0" />
              </TooltipTrigger>
              <TooltipContent>Importing...</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <CloudCheckIcon className="size-3 text-muted-foreground/60 shrink-0" />
              </TooltipTrigger>
              <TooltipContent>
                Saved{" "}
                {project?.updatedAt
                  ? formatDistanceToNow(project.updatedAt, { addSuffix: true })
                  : ""}
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Center: Code / Preview tabs */}
        <div className="flex items-center p-0.5 bg-muted/40 rounded-lg border border-border/40">
          <Tab
            label="Code"
            isActive={activeView === "editor"}
            onClick={() => setActiveView("editor")}
          />
          <Tab
            label="Preview"
            isActive={activeView === "preview"}
            onClick={() => setActiveView("preview")}
          />
        </div>

        {/* Right: Publish + Export + User */}
        <div className="flex items-center gap-1.5 shrink-0">
          {isPublished === null && (
            <button
              onClick={() => setPublishDialogOpen(true)}
              className="flex items-center gap-1.5 h-8 px-3 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-lg transition-colors"
            >
              Publish
            </button>
          )}
          <button
            onClick={() => setIntegrationsDialogOpen(true)}
            className="flex items-center gap-1.5 h-8 px-3 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-lg transition-colors"
          >
            <PlugIcon aria-hidden="true" className="size-3.5" />
            Integrations
          </button>
          <ExportPopover projectId={projectId} />
          <div className="w-px h-4 bg-border/40" />
          <UserButton
            appearance={{
              elements: {
                avatarBox: "size-6",
              },
            }}
          />
        </div>
      </nav>

      {/* ─── Content ─── */}
      <div className="flex-1 relative min-h-0">
        <div
          className={cn(
            "absolute inset-0 flex gap-2 transition-none",
            activeView !== "editor" && "opacity-0 pointer-events-none"
          )}
        >
          <Allotment defaultSizes={[DEFAULT_SIDEBAR_WIDTH, DEFAULT_MAIN_SIZE]}>
            <Allotment.Pane
              snap
              minSize={MIN_SIDEBAR_WIDTH}
              maxSize={MAX_SIDEBAR_WIDTH}
              preferredSize={DEFAULT_SIDEBAR_WIDTH}
            >
              <div className="h-full pr-1 box-border">
                <div className="h-full rounded-xl bg-card border border-border/60 shadow-[0_1px_3px_rgba(0,0,0,0.12),0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-[0_1px_3px_rgba(0,0,0,0.4),0_0_0_1px_rgba(255,255,255,0.03)] overflow-hidden flex flex-col">
                  <FileExplorer projectId={projectId} />
                </div>
              </div>
            </Allotment.Pane>
            <Allotment.Pane>
              <div className="h-full pl-1 box-border">
                <div className="h-full rounded-xl bg-card border border-border/60 shadow-[0_1px_3px_rgba(0,0,0,0.12),0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-[0_1px_3px_rgba(0,0,0,0.4),0_0_0_1px_rgba(255,255,255,0.03)] overflow-hidden flex flex-col relative">
                  <EditorView projectId={projectId} />
                </div>
              </div>
            </Allotment.Pane>
          </Allotment>
        </div>
        <div
          className={cn(
            "absolute inset-0 flex flex-col",
            activeView !== "preview" && "opacity-0 pointer-events-none"
          )}
        >
          <PreviewView projectId={projectId} />
        </div>
      </div>
    </div>
    </>
  );
};
