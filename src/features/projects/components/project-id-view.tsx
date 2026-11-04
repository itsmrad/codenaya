"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Allotment } from "allotment";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ChevronDownIcon,
  CloudCheckIcon,
  CodeIcon,
  EyeIcon,
  LoaderIcon,
  MessageSquareIcon,
  PanelLeftOpenIcon,
  PlugIcon,
  RocketIcon,
  SparklesIcon,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { useProjectCommands } from "@/lib/command-palette";
import { CodenayaLogo } from "@/components/codenaya-logo";
import { HelpMenu } from "@/components/help-menu";
import { UserMenu } from "@/components/user-menu";
import { useIsCompact, useIsMobile } from "@/hooks/use-mobile";
import { ConversationSidebar } from "@/features/conversations/components/conversation-sidebar";
import { EditorView } from "@/features/editor/components/editor-view";
import { useEditorStore } from "@/features/editor/store/use-editor-store";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { FileExplorer } from "./file-explorer";
import { Id } from "../../../../convex/_generated/dataModel";
import { PreviewView } from "./preview-view";
import { ExportPopover } from "./export-popover";
import { EnvVarsDialog } from "./env-vars-dialog";
import { useDownloadZip } from "../hooks/use-download-zip";
import { useChatPanelStore } from "../store/use-chat-panel-store";
import { SecurityScanDialog } from "@/features/security/components/security-scan-dialog";
import { useProject } from "../hooks/use-projects";
import { useFiles } from "../hooks/use-files";
import { useActiveRun } from "@/features/conversations/hooks/use-conversations";
import { hasRootPackageJson } from "@/features/sandbox-preview/utils/file-tree";
import { useProjectRename } from "../hooks/use-project-rename";
import { DeleteProjectDialog, ProjectActionsMenu } from "./project-actions";
import { PublishDialog } from "@/features/showcase/components/publish-dialog";
import { PublishedMenu } from "@/features/showcase/components/published-menu";
import { useIsProjectPublished } from "@/features/showcase/hooks/use-showcase";
import { useProjectIntegrations } from "@/features/integrations/components/project-integrations-context";
import { ProjectSkillsDialog } from "@/features/skills/components/project-skills-panel";
import {
  type IdeView,
  loadIdeSession,
  restorableTabs,
  saveIdeSession,
} from "../utils/ide-session";

const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 800;
const DEFAULT_SIDEBAR_WIDTH = 350;
const DEFAULT_MAIN_SIZE = 1000;

const noopSubscribe = () => () => {};

const VIEW_TABS = [
  { view: "chat", label: "Chat", icon: MessageSquareIcon },
  { view: "editor", label: "Code", icon: CodeIcon },
  { view: "preview", label: "Preview", icon: EyeIcon },
] as const;

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
  const isMobile = useIsMobile();
  // Below desktop width the chat is a tab rather than a side panel.
  const isCompact = useIsCompact();
  // Switching preview engines reloads the page with `?view=preview` so the user
  // lands back on the preview they were using.
  const openOnPreview = useSearchParams().get("view") === "preview";
  // Otherwise the view the user left the project on (#315), read in the browser
  // only so the server renders the default; else phones and tablets open on
  // the chat, and desktops, which show the chat as a side panel (see
  // ProjectIdLayout), fall back to the editor.
  const savedView = useSyncExternalStore(
    noopSubscribe,
    () => loadIdeSession(projectId)?.view ?? null,
    () => null,
  );
  const [pickedView, setSelectedView] = useState<IdeView | null>(openOnPreview ? "preview" : null);
  const selectedView: IdeView = pickedView ?? savedView ?? "chat";
  const activeView = !isCompact && selectedView === "chat" ? "editor" : selectedView;
  // The preview boots a cloud sandbox or WebContainer as soon as it mounts, so
  // mount it on first open and keep it mounted so tab switches don't reboot it.
  // It only opens by itself when the user left the project on it.
  const [previewOpened, setPreviewOpened] = useState(openOnPreview);
  if (activeView === "preview" && !previewOpened) setPreviewOpened(true);

  // A run is writing the first build when the project was seeded and no run
  // has written files yet, or when it starts before package.json exists.
  // Seeded projects have package.json from creation, so it can't tell (#338).
  // The preview mounts (hidden) once package.json lands so the sandbox boots
  // during the run, and the IDE switches to it when the run ends, unless the
  // user picked a tab meanwhile. Phones keep the chat and get a toast (#254).
  const activeRun = useActiveRun(projectId);
  const files = useFiles(projectId);
  const hasPackageJson = files ? hasRootPackageJson(files) : false;

  // Reopen the saved tabs once the file list is in, minus deleted files, then
  // keep the session saved as the user moves around (#315).
  const restoreTabs = useEditorStore((state) => state.restoreTabs);
  const { openTabs, activeTabId } = useEditorStore((state) => state.getTabState(projectId));
  const tabsRestored = useRef(false);
  useEffect(() => {
    if (tabsRestored.current || !files) return;
    tabsRestored.current = true;
    const session = loadIdeSession(projectId);
    if (!session) return;
    const tabs = restorableTabs(session, new Set(files.map((file) => file._id)));
    restoreTabs(projectId, tabs.openTabs as Id<"files">[], tabs.activeTabId as Id<"files"> | null);
  }, [files, projectId, restoreTabs]);
  useEffect(() => {
    // Not before the restore, or the empty starting tabs would overwrite the saved ones.
    if (!tabsRestored.current) return;
    saveIdeSession(projectId, { view: activeView, openTabs, activeTabId });
  }, [projectId, activeView, openTabs, activeTabId]);
  const [firstBuild, setFirstBuild] = useState(false);
  const [viewPickedDuringBuild, setViewPickedDuringBuild] = useState(false);
  const [previewReadyToasts, setPreviewReadyToasts] = useState(0);
  if (!firstBuild && activeRun && (activeRun.firstBuild || (files && !hasPackageJson))) {
    setFirstBuild(true);
    setViewPickedDuringBuild(false);
  }
  if (firstBuild && hasPackageJson && !previewOpened) setPreviewOpened(true);
  if (firstBuild && activeRun === null) {
    setFirstBuild(false);
    if (hasPackageJson && !viewPickedDuringBuild) {
      if (isMobile) {
        setPreviewReadyToasts((count) => count + 1);
      } else {
        setSelectedView("preview");
      }
    }
  }

  useEffect(() => {
    if (previewReadyToasts === 0) return;
    toast.success("Preview ready", {
      // Clear of the phone tab bar at the bottom.
      position: "top-center",
      action: {
        label: "Open",
        onClick: () => {
          setSelectedView("preview");
        },
      },
    });
  }, [previewReadyToasts]);

  const selectView = (view: IdeView) => {
    setSelectedView(view);
    if (firstBuild) setViewPickedDuringBuild(true);
  };
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);
  const [skillsDialogOpen, setSkillsDialogOpen] = useState(false);
  const { openIntegrations } = useProjectIntegrations();
  const project = useProject(projectId);
  const showcaseId = useIsProjectPublished(projectId);
  const rename = useProjectRename(project);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [envVarsOpen, setEnvVarsOpen] = useState(false);
  const zipExport = useDownloadZip(projectId);
  const { isHidden: isChatHidden, setHidden: setChatHidden } = useChatPanelStore();
  const router = useRouter();

  useProjectCommands({
    "show-code": () => selectView("editor"),
    "show-preview": () => selectView("preview"),
    // Desktops toggle the side panel (ProjectIdLayout); here the chat is a tab.
    "toggle-chat": isCompact
      ? () => selectView(activeView === "chat" ? "editor" : "chat")
      : null,
    publish: showcaseId === null ? () => setPublishDialogOpen(true) : null,
    "download-zip": () => void zipExport.download(),
    integrations: openIntegrations,
    skills: () => setSkillsDialogOpen(true),
    "env-vars": () => setEnvVarsOpen(true),
  });

  return (
    <>
      <PublishDialog
        open={publishDialogOpen}
        onOpenChange={setPublishDialogOpen}
        projectId={projectId}
        projectName={project?.name ?? ""}
      />
      <ProjectSkillsDialog
        projectId={projectId}
        open={skillsDialogOpen}
        onOpenChange={setSkillsDialogOpen}
      />
      <EnvVarsDialog
        projectId={projectId}
        open={envVarsOpen}
        onOpenChange={setEnvVarsOpen}
      />
      {/* The palette's Export ZIP; the Export popover's button has its own. */}
      <SecurityScanDialog pending={zipExport.gate.pending} onDismiss={zipExport.gate.dismiss} />
      {project && (
        <DeleteProjectDialog
          project={project}
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          onDeleting={() => router.replace("/")}
        />
      )}
    <div className="@container h-full flex flex-col gap-2">
      {/* ─── Unified Navbar ─── */}
      <nav className="shrink-0 h-11 flex items-center gap-3 px-3 rounded-xl bg-card border border-border/60 shadow-[0_1px_3px_rgba(0,0,0,0.12),0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-[0_1px_3px_rgba(0,0,0,0.4),0_0_0_1px_rgba(255,255,255,0.03)]">
        {/* Left: Brand + Project Name + Save */}
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          {/* Brings back the desktop chat panel after "Toggle chat panel". */}
          {!isCompact && isChatHidden && (
            <button
              onClick={() => setChatHidden(false)}
              aria-label="Show chat panel"
              title="Show chat panel"
              className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            >
              <PanelLeftOpenIcon aria-hidden="true" className="size-4" />
            </button>
          )}
          {/* Brand */}
          <Link href="/" className="flex items-center gap-2 shrink-0 group">
            <CodenayaLogo
              size={18}
              className="transition-transform duration-200 group-hover:rotate-12"
            />
            <span className="text-xs font-semibold tracking-tight text-foreground hidden @2xl:inline">
              codenaya
            </span>
          </Link>

          {/* Separator */}
          <div className="w-px h-4 bg-border/50 shrink-0" />

          {/* Project Name */}
          {rename.isRenaming ? (
            <input
              {...rename.inputProps}
              type="text"
              className="min-w-32 flex-1 @xl:flex-none text-xs bg-transparent text-foreground outline-none focus:ring-1 focus:ring-brand/40 aria-invalid:ring-destructive focus:ring-inset rounded px-1 py-0.5 font-medium max-w-44 truncate"
            />
          ) : (
            <button
              onClick={rename.start}
              className="min-w-0 text-xs font-medium text-foreground/80 hover:text-foreground truncate max-w-44 transition-colors"
            >
              {project?.name ?? "Loading..."}
            </button>
          )}
          {project && (
            <ProjectActionsMenu
              project={project}
              align="start"
              onRename={rename.start}
              onDelete={() => setDeleteOpen(true)}
              trigger={
                <button
                  aria-label="Project actions"
                  title="Project actions"
                  className="-ml-1.5 grid size-5 shrink-0 place-items-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                >
                  <ChevronDownIcon className="size-3.5" />
                </button>
              }
            />
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
            // Hidden on phones so the project name keeps its room.
            <Tooltip>
              <TooltipTrigger asChild>
                <CloudCheckIcon className="hidden @md:block size-3 text-muted-foreground/60 shrink-0" />
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

        {/* Center: view tabs (phones use the bottom tab bar; desktops keep
            the chat beside them, so they only switch Code / Preview) */}
        {!isMobile && (
          <div
            role="tablist"
            aria-label="Workspace views"
            className="flex items-center p-0.5 bg-muted/40 rounded-lg border border-border/40"
          >
            {VIEW_TABS.filter(({ view }) => isCompact || view !== "chat").map(
              ({ view, label }) => (
                <Tab
                  key={view}
                  label={label}
                  isActive={activeView === view}
                  onClick={() => selectView(view)}
                />
              )
            )}
          </div>
        )}

        {/* Right: Publish + Export + Help + User (phones hide it while renaming to make room) */}
        <div className={cn("flex items-center gap-1.5 shrink-0", rename.isRenaming && "hidden @xl:flex")}>
          {showcaseId && (
            <PublishedMenu
              showcaseId={showcaseId}
              className="flex items-center gap-1.5 h-8 px-2 @3xl:px-3 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-lg transition-colors"
            />
          )}
          {showcaseId === null && (
            <button
              onClick={() => setPublishDialogOpen(true)}
              aria-label="Publish"
              title="Publish"
              className="flex items-center gap-1.5 h-8 px-2 @3xl:px-3 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-lg transition-colors"
            >
              <RocketIcon aria-hidden="true" className="size-3.5" />
              <span className="hidden @3xl:inline">Publish</span>
            </button>
          )}
          <button
            onClick={openIntegrations}
            aria-label="Integrations"
            title="Integrations"
            className="flex items-center gap-1.5 h-8 px-2 @3xl:px-3 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-lg transition-colors"
          >
            <PlugIcon aria-hidden="true" className="size-3.5" />
            <span className="hidden @3xl:inline">Integrations</span>
          </button>
          <button
            onClick={() => setSkillsDialogOpen(true)}
            aria-label="Skills"
            title="Skills"
            className="flex items-center gap-1.5 h-8 px-2 @3xl:px-3 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-lg transition-colors"
          >
            <SparklesIcon aria-hidden="true" className="size-3.5" />
            <span className="hidden @3xl:inline">Skills</span>
          </button>
          <ExportPopover projectId={projectId} />
          <HelpMenu className="size-8" />
          <div className="w-px h-4 bg-border/40" />
          <UserMenu avatarClassName="size-6" />
        </div>
      </nav>

      {/* ─── Content ─── */}
      <div className="flex-1 relative min-h-0">
        {isCompact && (
          <div
            className={cn(
              "absolute inset-0 flex flex-col",
              activeView !== "chat" && "invisible"
            )}
          >
            <div className="h-full rounded-xl bg-card border border-border/60 shadow-[0_1px_3px_rgba(0,0,0,0.12),0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-[0_1px_3px_rgba(0,0,0,0.4),0_0_0_1px_rgba(255,255,255,0.03)] flex flex-col overflow-hidden relative">
              <ConversationSidebar projectId={projectId} />
            </div>
          </div>
        )}
        <div
          className={cn(
            "absolute inset-0 flex gap-2 transition-none",
            activeView !== "editor" && "invisible"
          )}
        >
          {/* Phones stack the explorer above the editor. */}
          <Allotment
            key={isMobile ? "stacked" : "side-by-side"}
            vertical={isMobile}
            defaultSizes={[DEFAULT_SIDEBAR_WIDTH, DEFAULT_MAIN_SIZE]}
          >
            <Allotment.Pane
              snap
              minSize={MIN_SIDEBAR_WIDTH}
              maxSize={MAX_SIDEBAR_WIDTH}
              preferredSize={DEFAULT_SIDEBAR_WIDTH}
            >
              <div className={cn("h-full box-border", isMobile ? "pb-1" : "pr-1")}>
                <div className="h-full rounded-xl bg-card border border-border/60 shadow-[0_1px_3px_rgba(0,0,0,0.12),0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-[0_1px_3px_rgba(0,0,0,0.4),0_0_0_1px_rgba(255,255,255,0.03)] overflow-hidden flex flex-col">
                  <FileExplorer projectId={projectId} />
                </div>
              </div>
            </Allotment.Pane>
            <Allotment.Pane>
              <div className={cn("h-full box-border", isMobile ? "pt-1" : "pl-1")}>
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
            activeView !== "preview" && "invisible"
          )}
        >
          {previewOpened && (
            <PreviewView
              projectId={projectId}
              firstBuild={firstBuild}
              visible={activeView === "preview"}
              onOpenEnvVars={() => setEnvVarsOpen(true)}
            />
          )}
        </div>
      </div>

      {/* ─── Phone tab bar ─── */}
      {isMobile && (
        <div
          role="tablist"
          aria-label="Workspace views"
          className="shrink-0 grid grid-cols-3 gap-1 p-1 mb-[env(safe-area-inset-bottom)] rounded-xl bg-card border border-border/60 shadow-[0_1px_3px_rgba(0,0,0,0.12),0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-[0_1px_3px_rgba(0,0,0,0.4),0_0_0_1px_rgba(255,255,255,0.03)]"
        >
          {VIEW_TABS.map(({ view, label, icon: Icon }) => (
            <button
              key={view}
              type="button"
              role="tab"
              aria-selected={activeView === view}
              onClick={() => selectView(view)}
              className={cn(
                "flex h-11 flex-col items-center justify-center gap-0.5 rounded-lg text-[11px] font-medium transition-colors select-none",
                activeView === view
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon aria-hidden="true" className="size-4" />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
    </>
  );
};
