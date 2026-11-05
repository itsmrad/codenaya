import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { PublicShell } from "@/components/landing/public-shell";
import { Reveal } from "@/components/landing/reveal";
import { SectionHeader } from "@/components/landing/section-header";
import { ShowcaseFeed } from "@/features/showcase/components/showcase-feed";
import { StarterTemplates } from "@/features/templates/components/starter-templates";

export const metadata: Metadata = {
  title: "Community showcase — Codenaya",
  description: "Apps people built with Codenaya. Open one to see it, share it, or remix it.",
};

const PUBLISH_STEPS = [
  { title: "Build it.", body: "Describe an app and the agent writes it, runs it and shows you a live preview." },
  {
    title: "Publish it.",
    body: "Choose Publish in the project bar, then add a title, a category, its tech stack and design style.",
  },
  { title: "Get remixed.", body: "Anyone can open it, upvote it, or remix a copy into their own workspace." },
];

// Public: the showcase queries need no auth, so signed-out visitors can browse.
const ShowcasePage = () => {
  return (
    <PublicShell>
      <section className="border-b border-border">
        <SectionHeader
          as="h1"
          label="Showcase"
          title="Community"
          accent="showcase."
          description="Apps people built with Codenaya. Open one to preview it or remix a copy into your workspace."
        />
      </section>

      {/* `templates-grid` lays the cards onto the grid (globals.css) */}
      <section className="templates-grid max-sm:border-b max-sm:border-border">
        <SectionHeader
          label="Templates"
          title="Start from"
          accent="a template."
          description="Official starters. Pick one and the agent builds it out into a full project."
        />
        <Reveal>
          <StarterTemplates
            title="Templates"
            description="Official starters: pick one to create a project the agent builds out"
          />
        </Reveal>
      </section>

      <section className="border-b border-border">
        <SectionHeader
          label="Community"
          title="Shared by"
          accent="builders."
          description="Search, sort and filter the apps people published, then open one to try it."
        />
        <div className="border-t border-border px-6 py-10 md:px-8 md:py-12">
          <Reveal>
            <ShowcaseFeed />
          </Reveal>
        </div>
      </section>

      <section className="border-b border-border">
        <SectionHeader label="Publish" title="Put yours" accent="on the wall." />
        <ol className="grid border-t border-border md:grid-cols-[repeat(3,1fr)_auto]">
          {PUBLISH_STEPS.map((step, i) => (
            <li key={step.title} className="border-border max-md:border-b md:border-r">
              <Reveal delay={i * 0.1} className="flex h-full flex-col gap-3 p-6 md:p-8">
                <span className="font-mono text-[11px] text-brand-text">0{i + 1}</span>
                <p className="text-[15px] leading-relaxed text-muted-foreground">
                  <strong className="font-semibold text-foreground">{step.title}</strong> {step.body}
                </p>
              </Reveal>
            </li>
          ))}
          <li className="flex items-center p-6 md:p-8">
            <Link
              href="/"
              className="group inline-flex h-10 items-center gap-2 rounded-md bg-brand px-5 text-sm font-medium whitespace-nowrap text-brand-foreground shadow-[inset_0_-4px_8px_rgb(0_0_0/0.12),0_1px_2px_rgb(232_130_79/0.4)] transition-colors hover:bg-brand/90"
            >
              Start building
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </li>
        </ol>
      </section>
    </PublicShell>
  );
};

export default ShowcasePage;
