"use client";

import { ArrowRightIcon } from "lucide-react";

import { cn } from "@/lib/utils";

import { Doc } from "../../../../convex/_generated/dataModel";
import { ProjectCard } from "./project-card";
import { CELL, SORTS } from "./projects-grid";

const RECENT_COUNT = 4;

interface RecentProjectsProps {
  projects: Doc<"projects">[] | undefined;
  onViewAll: () => void;
}

/** The last-edited projects, right under the composer: a sideways row on phones. */
export const RecentProjects = ({ projects, onViewAll }: RecentProjectsProps) => {
  // The query returns newest-created first; "recent" means last edited.
  const recent = projects && [...projects].sort(SORTS.updated.compare).slice(0, RECENT_COUNT);

  return (
    <section aria-labelledby="recent-heading">
      <div className="flex items-center justify-between gap-4 px-6 py-4 md:px-8">
        <h2 id="recent-heading" className="text-lg font-semibold tracking-[-0.02em]">
          Recent
        </h2>
        <button
          onClick={onViewAll}
          className="group flex shrink-0 items-center gap-1 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:text-foreground"
        >
          View all
          <ArrowRightIcon className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </button>
      </div>

      <div className="overflow-hidden border-t border-border">
        <div className="-mr-px -mb-px flex snap-x snap-mandatory overflow-x-auto sm:grid sm:grid-cols-2 sm:overflow-visible lg:grid-cols-4">
          {recent
            ? recent.map((project) => (
                <div key={project._id} className={cn(CELL, "w-[70%] shrink-0 snap-start sm:w-auto")}>
                  <ProjectCard project={project} />
                </div>
              ))
            : [...Array(RECENT_COUNT)].map((_, i) => (
                <div key={i} className={cn(CELL, "w-[70%] shrink-0 sm:w-auto")}>
                  <div className="aspect-[16/12.5] animate-pulse rounded-md bg-muted/50" />
                </div>
              ))}
        </div>
      </div>
    </section>
  );
};
