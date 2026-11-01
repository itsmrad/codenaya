"use client";

import { useEffect, useRef, useState } from "react";
import { MotionConfig, motion } from "motion/react";
import { useUser } from "@clerk/nextjs";
import { GitBranch, Search } from "lucide-react";

import { useCommandPalette } from "@/lib/command-palette";
import { useIsMac } from "@/lib/hooks/use-is-mac";
import { Kbd } from "@/components/ui/kbd";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CommunityRail } from "@/features/showcase/components/community-rail";
import { StarterTemplates } from "@/features/templates/components/starter-templates";
import { takePendingTemplate } from "@/features/templates/utils/pending-template";

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

const EASE = [0.22, 1, 0.36, 1] as const;

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
  const { user } = useUser();

  const allProjects = useProjects();
  // First-run users keep the stacked layout; returning users (and the loading
  // state, since most visits are returning) get Recent plus tabs.
  const hasNoProjects = allProjects?.length === 0;
  const { createProject, isSubmitting } = useCreateProjectFromPrompt();
  const [tab, setTab] = useDashboardTab();
  const tabsRef = useRef<HTMLDivElement>(null);

  // A template picked on /showcase or a prompt typed on the landing page
  // before signing up: create its project now. Taking them clears them, so
  // this runs at most once.
  useEffect(() => {
    const pendingTemplate = takePendingTemplate();
    const pendingPrompt = takePendingPrompt();
    if (pendingTemplate) void createProject(pendingTemplate.prompt, pendingTemplate.id);
    else if (pendingPrompt) void createProject(pendingPrompt);
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
    <StarterTemplates
      title="Start from a template"
      description="Official starters that boot in the preview, then the agent builds them out"
    />
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

      <main className="h-full overflow-y-auto bg-background">
        {/* ─── Hero: the prompt composer ─── */}
        <section
          className={`relative isolate overflow-hidden px-4 md:px-8 ${
            hasNoProjects ? "pt-14 pb-12 md:pt-20 md:pb-16" : "pt-6 pb-6 md:pt-12 md:pb-10"
          }`}
        >
          {/* Static backdrop: a soft brand glow over a dot grid that fades out. */}
          <div aria-hidden className="absolute inset-0 -z-10">
            <div className="absolute inset-0 bg-[radial-gradient(color-mix(in_oklab,var(--foreground)_10%,transparent)_1px,transparent_1px)] bg-size-[22px_22px] mask-[radial-gradient(ellipse_70%_60%_at_50%_0%,black,transparent)]" />
            <div className="absolute left-1/2 top-[-12rem] h-[26rem] w-[44rem] max-w-[140vw] -translate-x-1/2 rounded-full bg-brand/20 blur-[100px] dark:bg-brand/15" />
            <div className="absolute left-[60%] top-[-6rem] h-64 w-96 max-w-[90vw] rounded-full bg-violet-500/10 blur-[90px]" />
          </div>

          <div className="mx-auto max-w-2xl">
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: EASE }}
              className="text-center"
            >
              <p className="h-5 text-sm text-muted-foreground">
                {user?.firstName ? `Welcome back, ${user.firstName}` : null}
              </p>
              <h2 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl md:text-5xl">
                What will you build?
              </h2>
              <p className="mx-auto mt-3 max-w-md text-sm text-muted-foreground">
                {hasNoProjects
                  ? "Describe your first app, or start from one of these ideas."
                  : "Describe an app and Codenaya builds it, with a live preview."}
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.1, ease: EASE }}
              className="mt-7"
            >
              <PromptComposer
                onSubmit={createProject}
                isSubmitting={isSubmitting}
                showStarters
              />
              <div className="mt-5 flex items-center justify-center gap-4 text-xs text-muted-foreground">
                <button
                  onClick={() => setImportDialogOpen(true)}
                  className="flex items-center gap-1.5 transition-colors hover:text-foreground"
                >
                  <GitBranch className="size-3.5" />
                  Import from GitHub
                  <Kbd className="hidden text-[10px] sm:inline-flex">{isMac ? "⌘I" : "Ctrl+I"}</Kbd>
                </button>
                <span aria-hidden className="h-3 w-px bg-border" />
                <button
                  onClick={() => openCommandPalette(true)}
                  className="flex items-center gap-1.5 transition-colors hover:text-foreground"
                >
                  <Search className="size-3.5" />
                  Find a project
                  <Kbd className="hidden text-[10px] sm:inline-flex">{isMac ? "⌘K" : "Ctrl+K"}</Kbd>
                </button>
              </div>
            </motion.div>
          </div>
        </section>

        {/* ─── Your work, then templates and the community ─── */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.2, ease: EASE }}
          className={`mx-auto max-w-6xl px-4 pb-16 md:px-8 ${hasNoProjects ? "space-y-14" : "space-y-10"}`}
        >
          {hasNoProjects ? (
            <>
              {checklist}
              {projectsGrid}
              {templates}
              <CommunityRail />
            </>
          ) : (
            <>
              <RecentProjects
                projects={allProjects}
                onViewAll={() => {
                  setTab("projects");
                  tabsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              />
              {checklist}
              <Tabs
                ref={tabsRef}
                value={tab}
                onValueChange={(value) => setTab(value as DashboardTab)}
                className="scroll-mt-4 gap-6"
              >
                <TabsList>
                  <TabsTrigger value="projects" className="px-4">Projects</TabsTrigger>
                  <TabsTrigger value="templates" className="px-4">Templates</TabsTrigger>
                  <TabsTrigger value="community" className="px-4">Community</TabsTrigger>
                </TabsList>
                <TabsContent value="projects">{projectsGrid}</TabsContent>
                <TabsContent value="templates">{templates}</TabsContent>
                <TabsContent value="community">
                  <CommunityRail />
                </TabsContent>
              </Tabs>
            </>
          )}
        </motion.div>
      </main>
    </MotionConfig>
  );
};
