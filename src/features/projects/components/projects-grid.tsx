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
import { MENU_CONTENT, MENU_ITEM, MenuHeader } from "@/components/menu-chrome";
import { cn } from "@/lib/utils";

import { Doc } from "../../../../convex/_generated/dataModel";
import { ProjectCard } from "./project-card";

export const SORTS = {
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
      <div className="flex flex-wrap items-end justify-between gap-4 px-6 pt-10 pb-6 md:px-8">
        <div>
          <h2 id="projects-heading" className="flex items-baseline gap-3 text-3xl font-semibold tracking-[-0.035em]">
            <span>
              Your <span className="text-brand">projects</span>
            </span>
            {hasProjects && (
              <span className="font-mono text-xs font-normal tabular-nums tracking-normal text-muted-foreground">
                [ {projects!.length} ]
              </span>
            )}
          </h2>
          {hasProjects && sort === "updated" && (
            <p className="mt-1 text-sm text-muted-foreground">Last edited first, so you can pick up where you left off.</p>
          )}
        </div>
        {hasProjects && (
          // Search and sort as one control, in the prompt box's window style.
          <div className="flex h-9 w-full items-stretch overflow-hidden rounded-md border border-border bg-card transition-[border-color,box-shadow] focus-within:border-brand/50 focus-within:ring-4 focus-within:ring-brand/10 sm:w-auto">
            <div className="relative flex flex-1 items-center sm:w-64 sm:flex-none">
              <SearchIcon className="pointer-events-none absolute left-3 size-3.5 text-muted-foreground/70" />
              <input
                type="search"
                aria-label="Search projects"
                placeholder="Search projects…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-full w-full bg-transparent pl-8 pr-3 font-mono text-[12px] text-foreground outline-none placeholder:text-muted-foreground/60"
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex shrink-0 items-center gap-1.5 border-l border-border bg-muted/40 px-3 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted data-[state=open]:bg-muted data-[state=open]:text-foreground">
                  <ArrowUpDownIcon className="size-3.5" />
                  {SORTS[sort].label}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={6} className={cn(MENU_CONTENT, "w-48")}>
                <MenuHeader>Sort by</MenuHeader>
                <DropdownMenuRadioGroup value={sort} onValueChange={(v) => setSort(v as SortKey)} className="p-1">
                  {(Object.keys(SORTS) as SortKey[]).map((key) => (
                    <DropdownMenuRadioItem
                      key={key}
                      value={key}
                      className={cn(MENU_ITEM, "pl-8 data-[state=checked]:text-foreground [&_svg]:fill-brand [&_svg]:text-brand")}
                    >
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
        <Cells>
          {[...Array(4)].map((_, i) => (
            <div key={i} className={CELL}>
              <div className="aspect-[16/12.5] animate-pulse rounded-md bg-muted/50" />
            </div>
          ))}
        </Cells>
      ) : !hasProjects ? (
        <div className="relative flex flex-col items-center overflow-hidden border-t border-border px-6 py-16 text-center">
          <div aria-hidden className="absolute inset-0 -z-10 bg-[radial-gradient(color-mix(in_oklab,var(--foreground)_9%,transparent)_1px,transparent_1px)] bg-size-[18px_18px] mask-[radial-gradient(ellipse_50%_70%_at_50%_50%,black,transparent)]" />
          <FolderPlusIcon className="size-6 text-brand" />
          <p className="mt-4 text-sm font-medium">Your first project will appear here</p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            Describe an app above or pick one of the ideas. Already have code?
          </p>
          <button
            onClick={onImport}
            className="mt-5 h-9 rounded-md border border-border bg-card px-4 text-xs font-medium transition-colors hover:border-brand/40 hover:text-brand"
          >
            Import a GitHub repo
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <p className="border-t border-border py-14 text-center text-sm text-muted-foreground">No projects match “{query}”</p>
      ) : (
        <>
          <Cells>
            {!query && (
              <div className={CELL}>
                <button
                  onClick={onNewProject}
                  className="group flex h-full min-h-14 w-full items-center justify-center gap-2.5 rounded-md border border-dashed border-border text-muted-foreground transition-colors hover:border-brand/50 hover:bg-brand/[0.03] hover:text-foreground sm:min-h-40 sm:flex-col"
                >
                  <PlusIcon className="size-5 transition-transform duration-300 group-hover:rotate-90 group-hover:text-brand" />
                  <span className="text-sm font-medium">New project</span>
                  <Kbd className="hidden text-[11px] sm:inline-flex">{isMac ? "⌘J" : "Ctrl+J"}</Kbd>
                </button>
              </div>
            )}
            {visible.map((project, i) => (
              <motion.div
                key={project._id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: Math.min(i * 0.05, 0.35), ease: [0.22, 1, 0.36, 1] }}
                className={CELL}
              >
                <ProjectCard project={project} />
              </motion.div>
            ))}
          </Cells>
          {!query && filtered.length > COLLAPSED_COUNT && (
            <button
              onClick={() => setShowAll((v) => !v)}
              className="flex w-full items-center justify-center border-t border-border py-4 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            >
              {showAll ? "Show less" : `Show all ${filtered.length}`}
            </button>
          )}
        </>
      )}
    </section>
  );
};

/** One cell of the grid; borders on its right and bottom meet the next cell's. */
export const CELL = "spotlight border-r border-b border-border p-4 md:p-5";

/**
 * Cells on shared borders at any count: the grid runs 1px past its frame on
 * the right and bottom, so the outer edges fall on the page's own lines.
 */
const Cells = ({ children }: { children: React.ReactNode }) => (
  <div className="overflow-hidden border-t border-border">
    <div className="-mr-px -mb-px grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
  </div>
);
