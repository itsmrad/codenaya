"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { Authenticated } from "convex/react";
import { useTheme } from "next-themes";
import { FaGithub } from "react-icons/fa";
import {
  AlertCircleIcon,
  BookOpenIcon,
  ClockArrowUpIcon,
  CodeIcon,
  DownloadIcon,
  EyeIcon,
  GitBranchIcon,
  GlobeIcon,
  HistoryIcon,
  KeyboardIcon,
  KeyRoundIcon,
  LayoutTemplateIcon,
  Loader2Icon,
  type LucideIcon,
  MoonIcon,
  PanelLeftIcon,
  PlugIcon,
  PlusIcon,
  RocketIcon,
  SparklesIcon,
  SunIcon,
  UsersIcon,
} from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { useShortcutsDialog } from "@/components/shortcuts-dialog";
import {
  PROJECT_COMMANDS,
  type ProjectCommandId,
  useCommandPalette,
} from "@/lib/command-palette";
import { isCommandPaletteKey } from "@/lib/shortcuts";
import { isMacPlatform } from "@/lib/hooks/use-is-mac";
import { SETTINGS_NAV } from "@/features/settings/nav";

import { useProjects } from "../hooks/use-projects";
import { useChatPanelStore } from "../store/use-chat-panel-store";
import { ImportGithubDialog } from "./import-github-dialog";
import { NewProjectDialog } from "./new-project-dialog";
import { Doc } from "../../../../convex/_generated/dataModel";

const PROJECT_COMMAND_ICONS: Record<ProjectCommandId, LucideIcon> = {
  "show-code": CodeIcon,
  "show-preview": EyeIcon,
  "toggle-chat": PanelLeftIcon,
  "new-conversation": PlusIcon,
  "past-conversations": HistoryIcon,
  "version-history": ClockArrowUpIcon,
  publish: RocketIcon,
  "download-zip": DownloadIcon,
  integrations: PlugIcon,
  skills: SparklesIcon,
  "env-vars": KeyRoundIcon,
};

/** Actions that act on the chat, so a hidden chat panel is shown first. */
const CHAT_COMMANDS = new Set<ProjectCommandId>([
  "new-conversation",
  "past-conversations",
  "version-history",
]);

const ICON_CLASS = "size-4 text-muted-foreground";

const getProjectIcon = (project: Doc<"projects">) => {
  if (project.importStatus === "completed") {
    return <FaGithub className={ICON_CLASS} />
  }

  if (project.importStatus === "failed") {
    return <AlertCircleIcon className={ICON_CLASS} />;
  }

  if (project.importStatus === "importing") {
    return <Loader2Icon className={`${ICON_CLASS} animate-spin`} />;
  }

  return <GlobeIcon className={ICON_CLASS} />;
}

/** Projects need Convex auth, so this only mounts once it is ready. */
const ProjectItems = ({ onSelect }: { onSelect: (href: string) => void }) => {
  const projects = useProjects();

  return (
    <CommandGroup heading="Projects">
      {projects?.map((project) => (
        <CommandItem
          key={project._id}
          value={`${project.name}-${project._id}`}
          onSelect={() => onSelect(`/projects/${project._id}`)}
        >
          {getProjectIcon(project)}
          <span>{project.name}</span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
};

/**
 * The Cmd/Ctrl+K action hub (#314): create, go to a page or project, switch
 * the theme, and, in the IDE, run the toolbar's actions. Mounted once in the
 * root layout for signed-in users.
 */
export const CommandPalette = () => {
  const { isSignedIn } = useAuth();
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const { open, setOpen, commands } = useCommandPalette();
  const openShortcuts = useShortcutsDialog((state) => state.setOpen);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    if (!isSignedIn) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isCommandPaletteKey(event, isMacPlatform())) return;
      event.preventDefault();
      setOpen(!useCommandPalette.getState().open);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isSignedIn, setOpen]);

  if (!isSignedIn) return null;

  /** Closes the palette, then runs the picked action. */
  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  const goTo = (href: string) => {
    setOpen(false);
    router.push(href);
  };
  const isDark = resolvedTheme === "dark";
  const projectCommands = PROJECT_COMMANDS.filter(({ id }) => commands[id]);

  return (
    <>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Command palette"
        description="Search for a project, a page or an action"
        showCloseButton={false}
        // The prompt box's window look: mono bar, mono group labels, brand selection.
        className="rounded-lg sm:max-w-xl [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-normal [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.14em] [&_[cmdk-item][data-selected=true]]:bg-brand/[0.07]"
      >
        <div className="flex h-10 items-center gap-2 border-b border-border bg-muted/40 px-4 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          <span className="size-1.5 animate-pulse rounded-full bg-brand" />
          Commands
        </div>
        <CommandInput placeholder="Type a command or search..." />
        <CommandList className="max-h-[360px]">
          <CommandEmpty>No results found.</CommandEmpty>
          {projectCommands.length > 0 && (
            <CommandGroup heading="This project">
              {projectCommands.map(({ id, label }) => {
                const Icon = PROJECT_COMMAND_ICONS[id];
                return (
                  // Values are unique, so "Skills" here and in Go to don't clash.
                  <CommandItem key={id} value={`project ${label}`} onSelect={run(() => {
                    if (CHAT_COMMANDS.has(id)) useChatPanelStore.getState().setHidden(false);
                    commands[id]!();
                  })}>
                    <Icon className={ICON_CLASS} />
                    <span>{label}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}
          <CommandGroup heading="Create">
            <CommandItem onSelect={run(() => setNewProjectOpen(true))}>
              <PlusIcon className={ICON_CLASS} />
              <span>New project</span>
            </CommandItem>
            <CommandItem onSelect={run(() => setImportOpen(true))}>
              <GitBranchIcon className={ICON_CLASS} />
              <span>Import from GitHub</span>
            </CommandItem>
            {/* /showcase opens on the template picker. */}
            <CommandItem onSelect={() => goTo("/showcase")}>
              <LayoutTemplateIcon className={ICON_CLASS} />
              <span>Start from template</span>
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading="Go to">
            {SETTINGS_NAV.map(({ href, label, icon: Icon }) => (
              <CommandItem key={href} keywords={["settings"]} onSelect={() => goTo(href)}>
                <Icon className={ICON_CLASS} />
                <span>{label} settings</span>
              </CommandItem>
            ))}
            <CommandItem onSelect={() => goTo("/showcase")}>
              <UsersIcon className={ICON_CLASS} />
              <span>Showcase</span>
            </CommandItem>
            <CommandItem onSelect={() => goTo("/docs")}>
              <BookOpenIcon className={ICON_CLASS} />
              <span>Docs</span>
            </CommandItem>
          </CommandGroup>
          <Authenticated>
            <ProjectItems onSelect={goTo} />
          </Authenticated>
          <CommandGroup heading="Preferences">
            <CommandItem
              keywords={["theme", "dark", "light", "appearance"]}
              onSelect={run(() => setTheme(isDark ? "light" : "dark"))}
            >
              {isDark ? <SunIcon className={ICON_CLASS} /> : <MoonIcon className={ICON_CLASS} />}
              <span>{isDark ? "Switch to light theme" : "Switch to dark theme"}</span>
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading="Help">
            <CommandItem onSelect={run(() => openShortcuts(true))}>
              <KeyboardIcon className={ICON_CLASS} />
              <span>Keyboard shortcuts</span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
        <div className="flex h-10 items-center gap-4 border-t border-border bg-muted/30 px-4 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          <span className="flex items-center gap-1.5"><Kbd>↑↓</Kbd> Move</span>
          <span className="flex items-center gap-1.5"><Kbd>↵</Kbd> Run</span>
          <span className="ml-auto flex items-center gap-1.5"><Kbd>Esc</Kbd> Close</span>
        </div>
      </CommandDialog>
      {/* Mounted only while open: the composer subscribes to model queries. */}
      <Authenticated>
        {newProjectOpen && <NewProjectDialog open onOpenChange={setNewProjectOpen} />}
        {importOpen && <ImportGithubDialog open onOpenChange={setImportOpen} />}
      </Authenticated>
    </>
  );
};
