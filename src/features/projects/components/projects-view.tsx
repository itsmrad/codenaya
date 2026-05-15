"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Plus,
  GitBranch,
  Search,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { FaGithub } from "react-icons/fa";
import { AlertCircleIcon, GlobeIcon, Loader2Icon } from "lucide-react";

import { useIsMac } from "@/lib/hooks/use-is-mac";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BackgroundRippleEffect } from "@/components/ui/background-ripple-effect";

import { useProjects } from "../hooks/use-projects";
import { ProjectsCommandDialog } from "./projects-command-dialog";
import { ImportGithubDialog } from "./import-github-dialog";
import { NewProjectDialog } from "./new-project-dialog";

import { Doc } from "../../../../convex/_generated/dataModel";

const formatTimestamp = (timestamp: number) => {
  return formatDistanceToNow(new Date(timestamp), { addSuffix: true });
};

const getProjectIcon = (project: Doc<"projects">) => {
  if (project.importStatus === "completed") {
    return <FaGithub className="size-3.5 text-muted-foreground" />;
  }
  if (project.importStatus === "failed") {
    return <AlertCircleIcon className="size-3.5 text-muted-foreground" />;
  }
  if (project.importStatus === "importing") {
    return <Loader2Icon className="size-3.5 text-muted-foreground animate-spin" />;
  }
  return <GlobeIcon className="size-3.5 text-muted-foreground" />;
};

export const ProjectsView = () => {
  const [commandDialogOpen, setCommandDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [newProjectDialogOpen, setNewProjectDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const isMac = useIsMac();

  const allProjects = useProjects();

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

  const filteredProjects = allProjects?.filter((p) =>
    p.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <>
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

      <div className="h-full flex bg-background overflow-hidden">
        {/* ─── Left Panel (Collapsible) ─── */}
        <motion.aside
          initial={false}
          animate={{ width: collapsed ? 56 : 300 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          className="h-full border-r border-border/40 flex flex-col shrink-0 overflow-hidden"
        >
          {/* Collapse toggle */}
          <div className={`flex items-center ${collapsed ? "justify-center" : "justify-end"} px-3 pt-3 pb-1`}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setCollapsed(!collapsed)}
                  className="size-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                  aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                >
                  {collapsed ? (
                    <PanelLeftOpen className="size-4" />
                  ) : (
                    <PanelLeftClose className="size-4" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">
                {collapsed ? "Expand" : "Collapse"}
              </TooltipContent>
            </Tooltip>
          </div>

          {/* Search */}
          <div className={`px-3 ${collapsed ? "py-2" : "py-2"}`}>
            {collapsed ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setCollapsed(false)}
                    className="size-8 flex items-center justify-center rounded-lg bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors mx-auto"
                  >
                    <Search className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">Search projects</TooltipContent>
              </Tooltip>
            ) : (
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/60" />
                <input
                  type="text"
                  placeholder="Search..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full h-8 pl-8 pr-3 rounded-lg bg-muted/30 border border-border/40 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-brand/30 focus:border-brand/40 transition-all"
                />
              </div>
            )}
          </div>

          {/* Actions */}
          <div className={`px-3 py-1 space-y-0.5`}>
            {collapsed ? (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setNewProjectDialogOpen(true)}
                      className="size-8 flex items-center justify-center rounded-lg bg-brand/10 text-brand hover:bg-brand/20 transition-colors mx-auto"
                    >
                      <Plus className="size-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">New Project</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setImportDialogOpen(true)}
                      className="size-8 flex items-center justify-center rounded-lg bg-muted/40 text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors mx-auto"
                    >
                      <GitBranch className="size-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Import from GitHub</TooltipContent>
                </Tooltip>
              </>
            ) : (
              <>
                <button
                  onClick={() => setNewProjectDialogOpen(true)}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-foreground hover:bg-muted/50 transition-colors group"
                >
                  <div className="size-7 rounded-md bg-brand/10 flex items-center justify-center group-hover:bg-brand/20 transition-colors shrink-0">
                    <Plus className="size-3.5 text-brand" />
                  </div>
                  <span className="flex-1 text-left text-[13px]">New Project</span>
                  <Kbd className="text-[10px] text-muted-foreground bg-muted/40 border-border/30 px-1.5 py-0.5 rounded">
                    {isMac ? "⌘J" : "Ctrl+J"}
                  </Kbd>
                </button>
                <button
                  onClick={() => setImportDialogOpen(true)}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-foreground hover:bg-muted/50 transition-colors group"
                >
                  <div className="size-7 rounded-md bg-muted/40 flex items-center justify-center group-hover:bg-muted/60 transition-colors shrink-0">
                    <GitBranch className="size-3.5 text-muted-foreground" />
                  </div>
                  <span className="flex-1 text-left text-[13px]">Import GitHub</span>
                  <Kbd className="text-[10px] text-muted-foreground bg-muted/40 border-border/30 px-1.5 py-0.5 rounded">
                    {isMac ? "⌘I" : "Ctrl+I"}
                  </Kbd>
                </button>
              </>
            )}
          </div>

          {/* Divider */}
          <div className="px-3 py-2">
            <div className="h-px bg-border/30" />
          </div>

          {/* Projects List */}
          <div className="flex-1 overflow-y-auto px-3 pb-4">
            {!collapsed && (
              <p className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground mb-2 px-1">
                Projects
              </p>
            )}

            {filteredProjects === undefined ? (
              <div className="space-y-1.5">
                {[...Array(5)].map((_, i) => (
                  <div
                    key={i}
                    className={`${collapsed ? "size-8 mx-auto" : "h-9 w-full"} rounded-lg bg-muted/20 animate-pulse`}
                  />
                ))}
              </div>
            ) : filteredProjects.length === 0 ? (
              !collapsed && (
                <p className="text-xs text-muted-foreground/50 px-1 py-4">
                  {searchQuery ? "No results" : "No projects yet"}
                </p>
              )
            ) : (
              <div className={collapsed ? "space-y-1" : "space-y-0.5"}>
                {filteredProjects.map((project, i) => (
                  <motion.div
                    key={project._id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      duration: 0.3,
                      delay: Math.min(i * 0.03, 0.15),
                      ease: [0.22, 1, 0.36, 1],
                    }}
                  >
                    {collapsed ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Link
                            href={`/projects/${project._id}`}
                            className="size-8 flex items-center justify-center rounded-lg hover:bg-muted/50 transition-colors mx-auto group"
                          >
                            <div className="size-6 rounded-md bg-muted/30 flex items-center justify-center group-hover:bg-muted/60 transition-colors">
                              {getProjectIcon(project)}
                            </div>
                          </Link>
                        </TooltipTrigger>
                        <TooltipContent side="right">{project.name}</TooltipContent>
                      </Tooltip>
                    ) : (
                      <Link
                        href={`/projects/${project._id}`}
                        className="flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-muted/40 transition-colors group"
                      >
                        <div className="size-6 rounded-md bg-muted/30 flex items-center justify-center group-hover:bg-muted/50 transition-colors shrink-0">
                          {getProjectIcon(project)}
                        </div>
                        <span className="text-[13px] text-foreground/80 group-hover:text-foreground truncate flex-1 transition-colors">
                          {project.name}
                        </span>
                        <span className="text-[10px] text-muted-foreground/50 shrink-0">
                          {formatTimestamp(project.updatedAt)}
                        </span>
                      </Link>
                    )}
                  </motion.div>
                ))}
              </div>
            )}
          </div>
        </motion.aside>

        {/* ─── Right Panel (Showcase) ─── */}
        <motion.main
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
          className="flex-1 flex flex-col items-start justify-start relative overflow-hidden"
        >
          {/* Background Ripple Effect */}
          <BackgroundRippleEffect />

          {/* Content */}
          <div className="relative z-10 w-full max-w-4xl mx-auto px-8 mt-40 md:mt-52">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="text-center"
            >
              <h2 className="text-2xl font-bold text-foreground md:text-4xl lg:text-7xl">
                What will you build?
              </h2>
              <p className="mt-4 text-sm md:text-base text-muted-foreground max-w-xl mx-auto">
                Start a new project or pick up where you left off. Your workspace is ready.
              </p>
            </motion.div>

            {/* New Project prompt bar */}
            <motion.div
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.5, ease: [0.22, 1, 0.36, 1] }}
              className="mt-8 flex justify-center"
            >
              <button
                onClick={() => setNewProjectDialogOpen(true)}
                className="w-full max-w-md flex items-center gap-3 h-12 px-5 rounded-xl bg-card/80 backdrop-blur-sm border border-border/50 text-sm text-muted-foreground/60 hover:border-brand/30 hover:bg-card transition-all group cursor-text shadow-sm"
              >
                <Search className="size-4 text-muted-foreground/40 group-hover:text-brand/60 transition-colors" />
                <span>Describe what you want to build...</span>
                <Kbd className="ml-auto text-[10px] text-muted-foreground/50 bg-muted/40 border-border/30 px-1.5 py-0.5 rounded">
                  {isMac ? "⌘J" : "Ctrl+J"}
                </Kbd>
              </button>
            </motion.div>

            {/* Showcase hint */}
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.7 }}
              className="mt-6 text-center text-[11px] text-muted-foreground/40 tracking-wide"
            >
              Showcase coming soon
            </motion.p>
          </div>
        </motion.main>

        {/* Mobile bottom actions */}
        <div className="fixed bottom-0 left-0 right-0 md:hidden bg-background/90 backdrop-blur-xl border-t border-border/30 px-4 py-3 flex gap-2 z-40">
          <button
            onClick={() => setNewProjectDialogOpen(true)}
            className="flex-1 flex items-center justify-center gap-2 h-10 rounded-lg bg-brand text-white text-sm font-medium"
          >
            <Plus className="size-4" />
            New
          </button>
          <button
            onClick={() => setImportDialogOpen(true)}
            className="flex-1 flex items-center justify-center gap-2 h-10 rounded-lg bg-muted border border-border/40 text-foreground text-sm font-medium"
          >
            <GitBranch className="size-4" />
            Import
          </button>
        </div>
      </div>
    </>
  );
};
