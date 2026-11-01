"use client";

import { ArrowRightIcon } from "lucide-react";

import { Doc } from "../../../../convex/_generated/dataModel";
import { ProjectCard } from "./project-card";
import { SORTS } from "./projects-grid";

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
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2 id="recent-heading" className="text-base font-semibold tracking-tight">
          Recent
        </h2>
        <button
          onClick={onViewAll}
          className="group flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          View all
          <ArrowRightIcon className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </button>
      </div>

      <div className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-4 overflow-x-auto px-4 pt-1 pb-2 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 md:grid-cols-4">
        {recent
          ? recent.map((project) => (
              <div key={project._id} className="w-[70%] shrink-0 snap-start sm:w-auto">
                <ProjectCard project={project} />
              </div>
            ))
          : [...Array(RECENT_COUNT)].map((_, i) => (
              <div
                key={i}
                className="aspect-16/14 w-[70%] shrink-0 animate-pulse rounded-xl bg-muted/40 sm:w-auto"
              />
            ))}
      </div>
    </section>
  );
};
