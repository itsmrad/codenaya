"use client";

import { useState } from "react";
import { Allotment } from "allotment";
import { FaGithub } from "react-icons/fa";

import { cn } from "@/lib/utils";
import { EditorView } from "@/features/editor/components/editor-view";

import { FileExplorer } from "./file-explorer";
import { Id } from "../../../../convex/_generated/dataModel";
import { PreviewView } from "./preview-view";
import { ExportPopover } from "./export-popover";

const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 800;
const DEFAULT_SIDEBAR_WIDTH = 350;
const DEFAULT_MAIN_SIZE = 1000;

const Tab = ({
  label,
  isActive,
  onClick
}: {
  label: string;
  isActive: boolean;
  onClick: () => void;
}) => {
  return (
    <div
      onClick={onClick}
      className={cn(
        "flex items-center justify-center gap-2 px-4 py-1.5 cursor-pointer transition-all duration-200 select-none",
        "rounded-lg text-sm font-medium",
        isActive 
          ? "bg-background text-foreground shadow-sm ring-1 ring-border/50" 
          : "text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground"
      )}
    >
      <span>{label}</span>
    </div>
  );
};

export const ProjectIdView = ({ 
  projectId
}: { 
  projectId: Id<"projects">
}) => {
  const [activeView, setActiveView] = useState<"editor" | "preview">("editor");

  return (
    <div className="h-full flex flex-col gap-3">
      <nav className="flex items-center justify-between shrink-0">
        <div className="flex items-center p-1 bg-muted/40 rounded-xl border border-border/50 shadow-sm backdrop-blur-md">
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
        <div className="flex items-center">
          <div className="bg-muted/40 rounded-xl border border-border/50 shadow-sm p-1 flex items-center justify-center backdrop-blur-md">
            <ExportPopover projectId={projectId} />
          </div>
        </div>
      </nav>
      <div className="flex-1 relative">
        <div className={cn(
          "absolute inset-0 flex gap-3 transition-none",
          activeView !== "editor" && "opacity-0 pointer-events-none"
        )}>
          <Allotment defaultSizes={[DEFAULT_SIDEBAR_WIDTH, DEFAULT_MAIN_SIZE]}>
            <Allotment.Pane
              snap
              minSize={MIN_SIDEBAR_WIDTH}
              maxSize={MAX_SIDEBAR_WIDTH}
              preferredSize={DEFAULT_SIDEBAR_WIDTH}
            >
              <div className="h-full pr-1.5 box-border">
                <div className="h-full rounded-2xl bg-background border border-border/50 shadow-sm overflow-hidden flex flex-col">
                  <FileExplorer projectId={projectId} />
                </div>
              </div>
            </Allotment.Pane>
            <Allotment.Pane>
              <div className="h-full pl-1.5 box-border">
                <div className="h-full rounded-2xl bg-background border border-border/50 shadow-sm overflow-hidden flex flex-col relative">
                  <EditorView projectId={projectId} />
                </div>
              </div>
            </Allotment.Pane>
          </Allotment>
        </div>
        <div className={cn(
          "absolute inset-0 flex flex-col",
          activeView !== "preview" && "opacity-0 pointer-events-none"
        )}>
          <PreviewView projectId={projectId} />
        </div>
      </div>
    </div>
  );
};
