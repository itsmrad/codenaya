"use client";

import { useEffect, useState } from "react";
import { MotionConfig, motion } from "motion/react";
import { useUser } from "@clerk/nextjs";
import { GitBranch, Search } from "lucide-react";

import { useIsMac } from "@/lib/hooks/use-is-mac";
import { Kbd } from "@/components/ui/kbd";
import { CommunityRail } from "@/features/showcase/components/community-rail";

import { useProjects } from "../hooks/use-projects";
import { useCreateProjectFromPrompt } from "../hooks/use-create-project-from-prompt";
import { takePendingPrompt } from "../utils/pending-prompt";
import { ProjectsCommandDialog } from "./projects-command-dialog";
import { FirstRunChecklist } from "./first-run-checklist";
import { ImportGithubDialog } from "./import-github-dialog";
import { NewProjectDialog } from "./new-project-dialog";
import { PromptComposer } from "./prompt-composer";
import { ProjectsGrid } from "./projects-grid";

const EASE = [0.22, 1, 0.36, 1] as const;

export const ProjectsView = () => {
  const [commandDialogOpen, setCommandDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [newProjectDialogOpen, setNewProjectDialogOpen] = useState(false);
  const isMac = useIsMac();
  const { user } = useUser();

  const allProjects = useProjects();
  const hasNoProjects = allProjects?.length === 0;
  const { createProject, isSubmitting } = useCreateProjectFromPrompt();

  // A prompt typed on the landing page before signing up: create its project
  // now. Taking the prompt clears it, so this runs at most once.
  useEffect(() => {
    const pendingPrompt = takePendingPrompt();
    if (pendingPrompt) void createProject(pendingPrompt);
  }, [createProject]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        if (e.key === "k") {
          e.preventDefault();
          setCommandDialogOpen(true);
        }
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

  return (
    <MotionConfig reducedMotion="user">
      <ProjectsCommandDialog
        open={commandDialogOpen}
        onOpenChange={setCommandDialogOpen}
      />
      <ImportGithubDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
      />
      <NewProjectDialog
        open={newProjectDialogOpen}
        onOpenChange={setNewProjectDialogOpen}
      />

      <main className="h-full overflow-y-auto bg-background">
        {/* ─── Hero: the prompt composer ─── */}
        <section className="relative isolate overflow-hidden px-4 pt-14 pb-12 md:px-8 md:pt-20 md:pb-16">
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
                  onClick={() => setCommandDialogOpen(true)}
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

        {/* ─── Your work, then the community ─── */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.2, ease: EASE }}
          className="mx-auto max-w-6xl space-y-14 px-4 pb-16 md:px-8"
        >
          <FirstRunChecklist
            projects={allProjects}
            onNewProject={() => setNewProjectDialogOpen(true)}
          />
          <ProjectsGrid
            projects={allProjects}
            onNewProject={() => setNewProjectDialogOpen(true)}
            onImport={() => setImportDialogOpen(true)}
          />
          <CommunityRail />
        </motion.div>
      </main>
    </MotionConfig>
  );
};
