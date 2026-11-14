"use client";

import { useEffect, useRef, useState } from "react";
import { MotionConfig, motion } from "motion/react";
import { GitBranch, Search } from "lucide-react";

import { useCommandPalette } from "@/lib/command-palette";
import { useIsMac } from "@/lib/hooks/use-is-mac";
import { Kbd } from "@/components/ui/kbd";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CommunityRail } from "@/features/showcase/components/community-rail";
import { StarterTemplates } from "@/features/templates/components/starter-templates";
import { takePendingTemplate } from "@/features/templates/utils/pending-template";
import { GridPattern } from "@/components/landing/grid-pattern";
import { Reveal } from "@/components/landing/reveal";
import { LabelBar, SectionHeader } from "@/components/landing/section-header";

import { useProjects } from "../hooks/use-projects";
import { useDashboardTab } from "../hooks/use-dashboard-tab";
import { useCreateProjectFromPrompt } from "../hooks/use-create-project-from-prompt";
import { takePendingPrompt } from "../utils/pending-prompt";
import { takePendingImport } from "../utils/pending-import";
import { githubRepoUrl, parseGithubRepo } from "../utils/github-repo";
import type { DashboardTab } from "../utils/dashboard-tab";
import { FirstRunChecklist } from "./first-run-checklist";
import { ImportGithubDialog } from "./import-github-dialog";
import { NewProjectDialog } from "./new-project-dialog";
import { PromptComposer } from "./prompt-composer";
import { ProjectsGrid } from "./projects-grid";
import { RecentProjects } from "./recent-projects";

// Recent only adds something once the Projects tab below no longer shows them all at a glance.
const RECENT_MIN = 4;
const EASE = [0.22, 1, 0.36, 1] as const;

/** A dashboard tab as a cell of the grid. */
const TAB_CELL =
  "h-full flex-none rounded-none border-0 border-r border-border px-6 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground data-[state=active]:bg-brand/[0.07] data-[state=active]:text-foreground data-[state=active]:shadow-none dark:data-[state=active]:border-border dark:data-[state=active]:bg-brand/[0.07]";

interface ProjectsViewProps {
  /** A validated `owner/repo` from an "Open in Codenaya" link (`/?import=`). */
  linkedRepo?: string | null;
}

export const ProjectsView = ({ linkedRepo = null }: ProjectsViewProps) => {
  const openCommandPalette = useCommandPalette((state) => state.setOpen);
  const [importDialogOpen, setImportDialogOpen] = useState(linkedRepo !== null);
  const [importRepo, setImportRepo] = useState(linkedRepo);
  const [newProjectDialogOpen, setNewProjectDialogOpen] = useState(false);
  const isMac = useIsMac();

  const allProjects = useProjects();
  // First-run users keep the stacked layout; returning users (and the loading
  // state, since most visits are returning) get Recent plus tabs.
  const hasNoProjects = allProjects?.length === 0;
  const { createProject, isSubmitting } = useCreateProjectFromPrompt();
  const enter = (delay: number) => ({
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.7, delay, ease: EASE },
  });

  const [tab, setTab] = useDashboardTab();
  const tabsRef = useRef<HTMLDivElement>(null);

  // A template picked on /showcase or a prompt typed on the landing page
  // before signing up: create its project now. Taking them clears them, so
  // this runs at most once.
  useEffect(() => {
    const pendingTemplate = takePendingTemplate();
    const pendingPrompt = takePendingPrompt();
    if (pendingTemplate) void createProject(pendingTemplate.prompt, pendingTemplate.id);
    else if (pendingPrompt) void createProject(pendingPrompt, undefined, true);
  }, [createProject]);

  // A repo from an "Open in Codenaya" link kept across sign-up, when the
  // visitor didn't come back through /import. Always taken, so it can't
  // resurface later. The user still confirms; nothing is imported here.
  useEffect(() => {
    const repo = parseGithubRepo(takePendingImport() ?? "");
    if (linkedRepo || !repo) return;
    // Take-once localStorage state can only be read after mount; a lazy
    // initialiser would run twice in Strict Mode.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setImportRepo(repo);
    setImportDialogOpen(true);
  }, [linkedRepo]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl+K is the command palette's, handled app-wide.
      if (e.metaKey || e.ctrlKey) {
        if (e.key === "i") {
          e.preventDefault();
          setImportDialogOpen(true);
        }
        if (e.key === "j") {
          e.preventDefault();
          setNewProjectDialogOpen(true);
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const checklist = (
    <FirstRunChecklist
      projects={allProjects}
      onNewProject={() => setNewProjectDialogOpen(true)}
    />
  );
  const projectsGrid = (
    <ProjectsGrid
      projects={allProjects}
      onNewProject={() => setNewProjectDialogOpen(true)}
      onImport={() => setImportDialogOpen(true)}
    />
  );
  const templates = (
    /* ─── Templates, as cells on the grid (`templates-grid` in globals.css) ─── */
    <section className="templates-grid max-sm:border-b max-sm:border-border">
      <SectionHeader
        label="Templates"
        title="Start from"
        accent="a template."
        description="Official starters that boot in the preview, then the agent builds them out."
      />
      <Reveal>
        <StarterTemplates
          title="Start from a template"
          description="Official starters that boot in the preview, then the agent builds them out"
        />
      </Reveal>
    </section>
  );
  const community = (
    /* ─── The community; the whole block hides while the rail has nothing to show ─── */
    <div className="hidden border-b border-border has-[section]:block">
      <LabelBar label="Community" />
      <Reveal>
        <CommunityRail />
      </Reveal>
    </div>
  );

  return (
    <MotionConfig reducedMotion="user">
      <ImportGithubDialog
        // Remount on a new repo so the form takes it as its default value.
        key={importRepo}
        open={importDialogOpen}
        onOpenChange={(open) => {
          setImportDialogOpen(open);
          if (!open) setImportRepo(null);
        }}
        defaultUrl={importRepo ? githubRepoUrl(importRepo) : undefined}
      />
      <NewProjectDialog
        open={newProjectDialogOpen}
        onOpenChange={setNewProjectDialogOpen}
      />

      <main className="flex flex-1 flex-col overflow-x-clip bg-background">
        {/* The landing page's grid: one framed column, sections on shared borders. */}
        <div className="mx-auto w-full max-w-[1200px] flex-1 border-x border-border">
          {/* ─── Hero: the prompt composer ─── */}
          <section className="border-b border-border">
            <div className={`relative isolate overflow-hidden px-6 md:px-12 ${
                hasNoProjects ? "pt-16 pb-14 md:pt-20 md:pb-16" : "pt-8 pb-8 md:pt-12 md:pb-10"
              }`}>
              {/* The landing hero's backdrop: a grid fading out from the top centre. */}
              <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
                <div className="absolute inset-0 mask-[radial-gradient(ellipse_70%_60%_at_50%_0%,black,transparent)]">
                  <GridPattern />
                </div>
              </div>

              <div className="mx-auto max-w-3xl">
                <div className="text-center">
                  <motion.h2
                    {...enter(0.12)}
                    className="text-[2.5rem] font-medium leading-[1.04] tracking-[-0.03em] text-foreground sm:text-6xl"
                  >
                    What will you <span className="text-brand">build?</span>
                  </motion.h2>
                  <motion.p {...enter(0.2)} className="mx-auto mt-5 max-w-md text-[15px] leading-relaxed text-muted-foreground">
                    {hasNoProjects
                      ? "Describe your first app, or start from a template below."
                      : "Describe an app and Codenaya builds it, with a live preview."}
                  </motion.p>
                </div>

                <motion.div {...enter(0.28)} className="mt-9">
                  <PromptComposer
                    onSubmit={createProject}
                    isSubmitting={isSubmitting}
                  />
                  <div className="mt-5 flex items-center justify-center gap-4 text-xs text-muted-foreground">
                    <button
                      onClick={() => setImportDialogOpen(true)}
                      className="flex items-center gap-1.5 transition-colors hover:text-foreground"
                    >
                      <GitBranch className="size-3.5" />
                      Import from GitHub
                      <Kbd className="hidden text-[11px] sm:inline-flex">{isMac ? "⌘I" : "Ctrl+I"}</Kbd>
                    </button>
                    <span aria-hidden className="h-3 w-px bg-border" />
                    <button
                      onClick={() => openCommandPalette(true)}
                      className="flex items-center gap-1.5 transition-colors hover:text-foreground"
                    >
                      <Search className="size-3.5" />
                      Find a project
                      <Kbd className="hidden text-[11px] sm:inline-flex">{isMac ? "⌘K" : "Ctrl+K"}</Kbd>
                    </button>
                  </div>
                </motion.div>
              </div>
            </div>

          </section>

          {hasNoProjects ? (
            <>
              <section className="border-b border-border">
                <LabelBar label="Workspace" />
                {checklist}
                <Reveal>{projectsGrid}</Reveal>
              </section>
              {templates}
              {community}
            </>
          ) : (
            <>
              <section className="hidden border-b border-border has-[>:nth-child(2)]:block">
                <LabelBar label="Workspace" />
                {checklist}
                {allProjects && allProjects.length > RECENT_MIN && (
                  <RecentProjects
                    projects={allProjects}
                    onViewAll={() => {
                      setTab("projects");
                      tabsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}
                  />
                )}
              </section>
              <Tabs
                ref={tabsRef}
                value={tab}
                onValueChange={(value) => setTab(value as DashboardTab)}
                className="scroll-mt-16 gap-0"
              >
                <TabsList className="h-11 w-full justify-start rounded-none border-b border-border bg-transparent p-0">
                  <TabsTrigger value="projects" className={TAB_CELL}>Projects</TabsTrigger>
                  <TabsTrigger value="templates" className={TAB_CELL}>Templates</TabsTrigger>
                  <TabsTrigger value="community" className={TAB_CELL}>Community</TabsTrigger>
                </TabsList>
                <TabsContent value="projects" className="border-b border-border">{projectsGrid}</TabsContent>
                <TabsContent value="templates">{templates}</TabsContent>
                <TabsContent value="community">{community}</TabsContent>
              </Tabs>
            </>
          )}
        </div>
      </main>
    </MotionConfig>
  );
};
