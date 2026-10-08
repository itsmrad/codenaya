"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";

import type { ShowcaseProject } from "../types";
import { useShowcaseTrending } from "../hooks/use-showcase";
import { ShowcaseCard } from "./showcase-card";
import { ShowcaseDetailDialog } from "./showcase-detail-dialog";

const RAIL_SIZE = 4;

/**
 * A single row of top showcase projects for the dashboard, linking to the
 * full /showcase page. Hidden until there is something to show.
 */
export const CommunityRail = () => {
  const trending = useShowcaseTrending(RAIL_SIZE);
  const [selected, setSelected] = useState<ShowcaseProject | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  if (!trending || trending.length === 0) return null;

  return (
    <section aria-labelledby="community-heading">
      <ShowcaseDetailDialog open={detailOpen} onOpenChange={setDetailOpen} project={selected} />

      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h2 id="community-heading" className="text-base font-semibold tracking-tight">
            From the community
          </h2>
          <p className="text-xs text-muted-foreground">Apps people built with Codenaya</p>
        </div>
        <Link
          href="/showcase"
          className="group flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          Browse all
          <ArrowRightIcon className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>

      {/* Phones scroll the row sideways; wider screens show it as a grid. */}
      <div className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 lg:grid-cols-4">
        {trending.map((project) => (
          <div key={project._id} className="w-[78%] shrink-0 snap-start sm:w-auto">
            <ShowcaseCard
              project={project as ShowcaseProject}
              onClick={() => {
                setSelected(project as ShowcaseProject);
                setDetailOpen(true);
              }}
            />
          </div>
        ))}
      </div>
    </section>
  );
};
