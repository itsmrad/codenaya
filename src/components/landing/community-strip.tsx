"use client";

import { Component, type ReactNode } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { ArrowRight } from "lucide-react";

import { api } from "../../../convex/_generated/api";
import { ShowcaseCard } from "@/features/showcase/components/showcase-card";
import { useShowcaseTrending } from "@/features/showcase/hooks/use-showcase";
import { cn } from "@/lib/utils";
import { SectionHeader } from "./section-header";

const STRIP_SIZE = 6;

/**
 * How many of `count` cards a `columns`-wide grid shows: only full rows, so a
 * short last row never leaves a lone card (#253). Fewer than one row show as is.
 */
export const fullRowCount = (count: number, columns: number) =>
  count < columns ? count : count - (count % columns);

/**
 * Hides its children if they throw. The strip is optional, so a failing query
 * (e.g. the frontend deployed before the Convex functions it reads) must not
 * take the landing page down with it.
 */
export class HideOnError extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export const LandingCommunityStrip = () => (
  <HideOnError>
    <CommunityStrip />
  </HideOnError>
);

/**
 * Proof from real usage: the live "N projects built" total and the top
 * public showcase projects, each linking to its /showcase page. Renders
 * nothing until there is a real number or project to show.
 */
const CommunityStrip = () => {
  const trending = useShowcaseTrending(STRIP_SIZE);
  const projectsBuilt = useQuery(api.stats.projectsBuilt);

  const hasProjects = !!trending && trending.length > 0;
  if (!hasProjects && !projectsBuilt) return null;

  return (
    <section aria-label="Built with Codenaya" className="border-b border-border">
      <SectionHeader
        label="Community"
        title="Built with"
        accent="Codenaya"
        description={
          [
            projectsBuilt &&
              `${projectsBuilt.toLocaleString("en-US")} ${projectsBuilt === 1 ? "project" : "projects"} built so far.`,
            hasProjects && "Here are the ones people shared.",
          ]
            .filter(Boolean)
            .join(" ")
        }
      />

      {hasProjects && (
        // Per-cell lines, clipped at the outer edges. From `sm` only full rows show (2 columns, 3 at `lg`).
        <div className="overflow-hidden border-t border-border">
          <div className="-mr-px -mb-px grid sm:grid-cols-2 lg:grid-cols-3">
            {trending.map((project, index) => (
              <div
                key={project._id}
                className={cn(
                  "border-r border-b border-border p-4 md:p-5",
                  index >= fullRowCount(trending.length, 2) && "sm:max-lg:hidden",
                  index >= fullRowCount(trending.length, 3) && "lg:hidden",
                )}
              >
                <ShowcaseCard project={project} href={`/showcase/${project._id}`} />
              </div>
            ))}
          </div>
        </div>
      )}

      <Link
        href="/showcase"
        className="group flex items-center justify-between border-t border-border px-6 py-5 text-sm font-medium text-foreground transition-colors hover:bg-muted/50 md:px-8"
      >
        Browse the showcase
        <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
      </Link>
    </section>
  );
};
