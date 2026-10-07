"use client";

import { Component, type ReactNode } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { ArrowRight } from "lucide-react";

import { api } from "../../../convex/_generated/api";
import { ShowcaseCard } from "@/features/showcase/components/showcase-card";
import { useShowcaseTrending } from "@/features/showcase/hooks/use-showcase";

const STRIP_SIZE = 6;

/**
 * Hides its children if they throw. The strip is optional, so a failing query
 * (e.g. the frontend deployed before the Convex functions it reads) must not
 * take the landing page down with it.
 */
class HideOnError extends Component<{ children: ReactNode }, { failed: boolean }> {
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
    <section aria-labelledby="community-heading" className="relative py-14 md:py-20">
      <div className="max-w-6xl mx-auto px-6 md:px-8">
        <div className="text-center mb-12 md:mb-16">
          <p className="text-xs uppercase tracking-[0.25em] text-brand font-mono mb-4">
            Community
          </p>
          <h2
            id="community-heading"
            className="text-3xl md:text-5xl font-bold tracking-tight text-foreground"
          >
            Built with Codenaya
          </h2>
          {!!projectsBuilt && (
            <p className="mt-4 text-muted-foreground">
              <span className="font-mono font-semibold text-foreground tabular-nums">
                {projectsBuilt.toLocaleString("en-US")}
              </span>{" "}
              {projectsBuilt === 1 ? "project" : "projects"} built
            </p>
          )}
        </div>

        {hasProjects && (
          // Flex rather than grid so a short last row stays centred.
          <div className="flex flex-wrap justify-center gap-5">
            {trending.map((project) => (
              <div
                key={project._id}
                className="w-full sm:w-[calc((100%-1.25rem)/2)] lg:w-[calc((100%-2.5rem)/3)]"
              >
                <ShowcaseCard project={project} href={`/showcase/${project._id}`} />
              </div>
            ))}
          </div>
        )}

        <div className="mt-8 flex justify-center">
          <Link
            href="/showcase"
            className="group inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Browse the showcase
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
      </div>
    </section>
  );
};
