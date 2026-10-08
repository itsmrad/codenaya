"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { ArrowUpDownIcon, FolderPlusIcon, PlusIcon, SearchIcon } from "lucide-react";

import { Kbd } from "@/components/ui/kbd";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIsMac } from "@/lib/hooks/use-is-mac";

import { Doc } from "../../../../convex/_generated/dataModel";
import { ProjectCard } from "./project-card";

const SORTS = {
  updated: { label: "Last edited", compare: (a: Doc<"projects">, b: Doc<"projects">) => b.updatedAt - a.updatedAt },
  created: { label: "Newest", compare: (a: Doc<"projects">, b: Doc<"projects">) => b._creationTime - a._creationTime },
  name: { label: "Name", compare: (a: Doc<"projects">, b: Doc<"projects">) => a.name.localeCompare(b.name) },
};
type SortKey = keyof typeof SORTS;

/** Cards shown before "Show all": two rows at the widest layout, with the New tile. */
const COLLAPSED_COUNT = 7;

interface ProjectsGridProps {
  projects: Doc<"projects">[] | undefined;
  onNewProject: () => void;
  onImport: () => void;
}

/** "Your projects": a searchable, sortable grid of project cards. */
export const ProjectsGrid = ({ projects, onNewProject, onImport }: ProjectsGridProps) => {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("updated");
  const [showAll, setShowAll] = useState(false);
  const isMac = useIsMac();

  const filtered = (projects ?? [])
    .filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()))
    .sort(SORTS[sort].compare);
  const visible = showAll || query ? filtered : filtered.slice(0, COLLAPSED_COUNT);
  const hasProjects = (projects?.length ?? 0) > 0;

  return (
    <section aria-labelledby="projects-heading">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <h2 id="projects-heading" className="flex items-baseline gap-2 text-base font-semibold tracking-tight">
          Your projects
          {hasProjects && (
            <span className="text-xs font-normal tabular-nums text-muted-foreground">{projects!.length}</span>
          )}
        </h2>
        {hasProjects && (
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <div className="relative flex-1 sm:w-56 sm:flex-none">
              <SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <input
                type="search"
                aria-label="Search projects"
                placeholder="Search projects…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-8 w-full rounded-lg border border-border/60 bg-card pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground/60 transition-colors focus:border-ring/50 focus:outline-none focus:ring-2 focus:ring-ring/15"
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border/60 bg-card px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
                  <ArrowUpDownIcon className="size-3.5" />
                  {SORTS[sort].label}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuRadioGroup value={sort} onValueChange={(v) => setSort(v as SortKey)}>
                  {(Object.keys(SORTS) as SortKey[]).map((key) => (
                    <DropdownMenuRadioItem key={key} value={key}>
                      {SORTS[key].label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      {projects === undefined ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="aspect-[16/12.5] animate-pulse rounded-xl bg-muted/40" />
          ))}
        </div>
      ) : !hasProjects ? (
        <div className="flex flex-col items-center rounded-2xl border border-dashed border-border px-6 py-12 text-center">
          <div className="grid size-11 place-items-center rounded-xl bg-brand/10">
            <FolderPlusIcon className="size-5 text-brand" />
          </div>
          <p className="mt-4 text-sm font-medium">Your first project will appear here</p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            Describe an app above or pick one of the ideas. Already have code?
          </p>
          <button
            onClick={onImport}
            className="mt-4 h-8 rounded-lg border border-border bg-card px-3 text-xs font-medium transition-colors hover:border-brand/40 hover:text-brand"
          >
            Import a GitHub repo
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">No projects match “{query}”</p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {!query && (
              <button
                onClick={onNewProject}
                className="group flex min-h-14 items-center justify-center gap-2.5 rounded-xl sm:min-h-40 sm:flex-col border border-dashed border-border text-muted-foreground transition-colors hover:border-brand/50 hover:bg-brand/[0.03] hover:text-foreground"
              >
                <span className="grid size-7 place-items-center rounded-full bg-muted sm:size-9 transition-colors group-hover:bg-brand/15 group-hover:text-brand">
                  <PlusIcon className="size-4" />
                </span>
                <span className="text-sm font-medium">New project</span>
                <Kbd className="hidden text-[10px] sm:inline-flex">{isMac ? "⌘J" : "Ctrl+J"}</Kbd>
              </button>
            )}
            {visible.map((project, i) => (
              <motion.div
                key={project._id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, delay: Math.min(i * 0.04, 0.3), ease: "easeOut" }}
              >
                <ProjectCard project={project} />
              </motion.div>
            ))}
          </div>
          {!query && filtered.length > COLLAPSED_COUNT && (
            <div className="mt-5 flex justify-center">
              <button
                onClick={() => setShowAll((v) => !v)}
                className="h-8 rounded-lg border border-border/60 bg-card px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                {showAll ? "Show less" : `Show all ${filtered.length}`}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
};
