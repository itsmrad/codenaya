"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Plus,
  GitBranch,
  Search,
  PanelLeftClose,
  PanelLeftOpen,
  ArrowUpDown,
} from "lucide-react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { FaGithub } from "react-icons/fa";
import { AlertCircleIcon, GlobeIcon, Loader2Icon } from "lucide-react";

import { useIsMac } from "@/lib/hooks/use-is-mac";
import { Kbd } from "@/components/ui/kbd";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BackgroundRippleEffect } from "@/components/ui/background-ripple-effect";
import { ShowcaseCard } from "@/features/showcase/components/showcase-card";
import { ShowcaseDetailDialog } from "@/features/showcase/components/showcase-detail-dialog";
import { useShowcaseTrending } from "@/features/showcase/hooks/use-showcase";
import {
  TECH_STACK_OPTIONS,
  DESIGN_STYLE_OPTIONS,
  CATEGORY_OPTIONS,
} from "@/features/showcase/constants/tags";

import { useProjects } from "../hooks/use-projects";
import { Doc } from "../../../../convex/_generated/dataModel";
import { ProjectsCommandDialog } from "./projects-command-dialog";
import { ImportGithubDialog } from "./import-github-dialog";
import { NewProjectDialog } from "./new-project-dialog";

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
  const [projectSort, setProjectSort] = useState<"updated-desc" | "updated-asc" | "created-desc" | "created-asc">("updated-desc");
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

  const filteredProjects = allProjects
    ?.filter((p) => p.name.toLowerCase().includes(searchQuery.toLowerCase()))
    .sort((a, b) => {
      switch (projectSort) {
        case "updated-desc": return b.updatedAt - a.updatedAt;
        case "updated-asc": return a.updatedAt - b.updatedAt;
        case "created-desc": return b._creationTime - a._creationTime;
        case "created-asc": return a._creationTime - b._creationTime;
        default: return 0;
      }
    });

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
              <div className="flex items-center justify-between mb-2 px-1">
                <p className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                  Projects
                </p>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="size-5 flex items-center justify-center rounded text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/40 transition-colors">
                      <ArrowUpDown className="size-3" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem onClick={() => setProjectSort("updated-desc")}>
                      Recently Updated ↓
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setProjectSort("updated-asc")}>
                      Recently Updated ↑
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setProjectSort("created-desc")}>
                      Created At ↓
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setProjectSort("created-asc")}>
                      Created At ↑
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
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
          className="flex-1 flex flex-col relative overflow-y-auto"
        >
          {/* Hero section with background — compact */}
          <div className="relative flex flex-col items-center justify-center overflow-hidden shrink-0 py-14 md:py-20">
            <BackgroundRippleEffect />

            <div className="relative z-10 w-full max-w-4xl mx-auto px-8">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
                className="text-center"
              >
                <h2 className="text-2xl font-bold text-foreground md:text-4xl lg:text-6xl">
                  What will you build?
                </h2>
                <p className="mt-3 text-sm text-muted-foreground max-w-md mx-auto">
                  Start a new project or pick up where you left off.
                </p>
              </motion.div>

              {/* New Project prompt bar */}
              <motion.div
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.5, ease: [0.22, 1, 0.36, 1] }}
                className="mt-6 flex justify-center"
              >
                <button
                  onClick={() => setNewProjectDialogOpen(true)}
                  className="w-full max-w-md flex items-center gap-3 h-11 px-5 rounded-xl bg-card/80 backdrop-blur-sm border border-border/50 text-sm text-muted-foreground/60 hover:border-brand/30 hover:bg-card transition-all group cursor-text shadow-sm"
                >
                  <Search className="size-4 text-muted-foreground/40 group-hover:text-brand/60 transition-colors" />
                  <span>Describe what you want to build...</span>
                  <Kbd className="ml-auto text-[10px] text-muted-foreground/50 bg-muted/40 border-border/30 px-1.5 py-0.5 rounded">
                    {isMac ? "⌘J" : "Ctrl+J"}
                  </Kbd>
                </button>
              </motion.div>
            </div>
          </div>

          {/* Showcase Feed — starts immediately after hero */}
          <ShowcaseFeed onNewProject={() => setNewProjectDialogOpen(true)} />
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

// ─── Showcase Feed (embedded in right panel) ───

type ShowcaseProject = Doc<"showcaseProjects"> & { previewUrl: string | null };
type SortBy = "newest" | "upvotes" | "imports";

const ShowcaseFeed = ({ onNewProject }: { onNewProject: () => void }) => {
  const [showcaseSearch, setShowcaseSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("newest");
  const [selectedCategory, setSelectedCategory] = useState<string | undefined>(undefined);
  const [selectedTech, setSelectedTech] = useState<string[]>([]);
  const [selectedDesign, setSelectedDesign] = useState<string[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [selectedProject, setSelectedProject] = useState<ShowcaseProject | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const trending = useShowcaseTrending(30);

  const handleCardClick = (project: ShowcaseProject) => {
    setSelectedProject(project);
    setDetailOpen(true);
  };

  // Client-side filtering
  const filteredProjects = (trending ?? []).filter((project) => {
    if (showcaseSearch.length >= 2) {
      const q = showcaseSearch.toLowerCase();
      if (!project.title.toLowerCase().includes(q)) return false;
    }
    if (selectedCategory && project.category !== selectedCategory) return false;
    if (selectedTech.length > 0) {
      if (!selectedTech.some((t) => project.techStack.includes(t))) return false;
    }
    if (selectedDesign.length > 0) {
      if (!selectedDesign.some((d) => project.designStyle.includes(d))) return false;
    }
    return true;
  });

  // Sort
  const sortedProjects = [...filteredProjects].sort((a, b) => {
    if (sortBy === "upvotes") return b.upvotes - a.upvotes;
    if (sortBy === "imports") return b.importCount - a.importCount;
    return b.publishedAt - a.publishedAt;
  });

  const hasActiveFilters = selectedCategory || selectedTech.length > 0 || selectedDesign.length > 0;

  return (
    <>
      <ShowcaseDetailDialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        project={selectedProject}
      />

      <div className="px-6 md:px-10 pb-10">
        {/* Header + Search + Sort */}
        <div className="flex items-center gap-3 mb-4">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/50" />
            <input
              type="text"
              placeholder="Search showcase..."
              value={showcaseSearch}
              onChange={(e) => setShowcaseSearch(e.target.value)}
              className="w-full h-8 pl-8 pr-3 rounded-lg bg-muted/30 border border-border/40 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-brand/30 focus:border-brand/40 transition-all"
            />
          </div>

          {/* Sort */}
          <div className="flex items-center p-0.5 bg-muted/30 rounded-lg border border-border/40">
            {(["newest", "upvotes", "imports"] as SortBy[]).map((s) => (
              <button
                key={s}
                onClick={() => setSortBy(s)}
                className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${
                  sortBy === s
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {s === "newest" ? "New" : s === "upvotes" ? "Top" : "Popular"}
              </button>
            ))}
          </div>

          {/* Filter toggle */}
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`h-8 px-2.5 rounded-lg border text-[11px] font-medium transition-colors ${
              showFilters || hasActiveFilters
                ? "border-brand/40 text-brand bg-brand/5"
                : "border-border/40 text-muted-foreground hover:text-foreground"
            }`}
          >
            Filters{hasActiveFilters ? " ●" : ""}
          </button>
        </div>

        {/* Filter panel */}
        {showFilters && (
          <div className="mb-4 p-3 rounded-xl border border-border/40 bg-card/50 space-y-3">
            {/* Category */}
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Category</p>
              <div className="flex flex-wrap gap-1">
                {CATEGORY_OPTIONS.map((cat) => (
                  <Badge
                    key={cat.value}
                    variant={selectedCategory === cat.value ? "default" : "outline"}
                    className="cursor-pointer text-[10px] px-2 py-0"
                    onClick={() => setSelectedCategory(selectedCategory === cat.value ? undefined : cat.value)}
                  >
                    {cat.label}
                  </Badge>
                ))}
              </div>
            </div>
            {/* Tech */}
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Tech Stack</p>
              <div className="flex flex-wrap gap-1">
                {TECH_STACK_OPTIONS.map((tag) => (
                  <Badge
                    key={tag}
                    variant={selectedTech.includes(tag) ? "default" : "outline"}
                    className="cursor-pointer text-[10px] px-2 py-0"
                    onClick={() => setSelectedTech((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag])}
                  >
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
            {/* Design */}
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Design Style</p>
              <div className="flex flex-wrap gap-1">
                {DESIGN_STYLE_OPTIONS.map((tag) => (
                  <Badge
                    key={tag}
                    variant={selectedDesign.includes(tag) ? "default" : "outline"}
                    className="cursor-pointer text-[10px] px-2 py-0"
                    onClick={() => setSelectedDesign((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag])}
                  >
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
            {hasActiveFilters && (
              <button
                onClick={() => { setSelectedCategory(undefined); setSelectedTech([]); setSelectedDesign([]); }}
                className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                Clear all
              </button>
            )}
          </div>
        )}

        {/* Grid */}
        {sortedProjects.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-sm text-muted-foreground/50">
              {trending === undefined
                ? "Loading..."
                : trending.length === 0
                  ? "No showcase projects yet. Be the first to publish!"
                  : "No projects match your filters"}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {sortedProjects.map((project) => (
              <ShowcaseCard
                key={project._id}
                project={project as ShowcaseProject}
                onClick={() => handleCardClick(project as ShowcaseProject)}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
};
