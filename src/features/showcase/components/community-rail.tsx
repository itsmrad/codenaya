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

      <div className="flex items-end justify-between gap-4 px-6 pt-10 pb-6 md:px-8">
        <div>
          <h2 id="community-heading" className="text-3xl font-semibold tracking-[-0.035em]">
            From the <span className="text-brand">community</span>
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">Apps people built with Codenaya</p>
        </div>
        <Link
          href="/showcase"
          className="group flex shrink-0 items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:text-foreground"
        >
          Browse all
          <ArrowRightIcon className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>

      {/* Cells on shared borders: the grid runs 1px past its frame, so the outer edges fall on the page's lines. */}
      <div className="overflow-hidden border-t border-border">
        <div className="-mr-px -mb-px grid sm:grid-cols-2 lg:grid-cols-4">
          {trending.map((project) => (
            <div key={project._id} className="border-r border-b border-border p-4 md:p-5">
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
      </div>
    </section>
  );
};
