"use client";

import { motion } from "motion/react";
import { ArrowRight } from "lucide-react";

import { AI_PROVIDER_IDS } from "@/features/ai-providers/registry";
import { GITHUB_REPO_URL } from "@/lib/site";
import { GridPattern } from "./grid-pattern";
import { HeroDemo } from "./hero-demo";
import { LandingPromptComposer } from "./landing-prompt-composer";
import { CountUp } from "./reveal";

const EASE = [0.22, 1, 0.36, 1] as const;

const CHIPS = ["Bring your own key", "Cloud sandbox", "GitHub export", "Desktop + phone"];

// Named providers only; "custom" is the any-endpoint option, counted by the "+".
const NAMED_PROVIDERS = AI_PROVIDER_IDS.filter((id) => id !== "custom").length;

const STATS = [
  { value: 300, suffix: "", caption: "Free credits every month" },
  { value: NAMED_PROVIDERS, suffix: "+", caption: "Key providers, plus any OpenAI-compatible endpoint" },
];

export const LandingHero = () => {
  const enter = (delay: number) => ({
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.7, delay, ease: EASE },
  });

  return (
    <section className="relative border-b border-border">
      <div className="relative overflow-hidden px-6 pt-20 pb-14 text-center md:px-12 md:pt-28 md:pb-20">
        {/* The grid fades out from the top centre */}
        <div className="pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,black,transparent)]">
          <GridPattern />
        </div>

        <div className="relative mx-auto max-w-5xl">
          <motion.ul {...enter(0.1)} className="flex flex-wrap justify-center gap-x-1 gap-y-2">
            {CHIPS.map((chip) => (
              <li key={chip} className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                [ {chip} ]
              </li>
            ))}
          </motion.ul>

          <motion.h1
            {...enter(0.2)}
            className="mt-7 text-[2.75rem] font-medium leading-[1.04] tracking-[-0.03em] text-foreground sm:text-6xl lg:text-[5.25rem]"
          >
            Build with AI.
            <br />
            Ship from your <span className="text-brand">browser</span>.
          </motion.h1>

          <motion.p {...enter(0.3)} className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-pretty text-muted-foreground">
            A browser IDE with an AI agent that writes your code, a live preview to run it, and GitHub
            export when it&apos;s done. On desktop or phone.
          </motion.p>

          <motion.div {...enter(0.4)} className="mx-auto mt-10 max-w-3xl">
            <LandingPromptComposer className="text-left" />
            <div className="mt-5 flex items-center justify-center gap-5 text-xs text-muted-foreground">
              <a
                href={GITHUB_REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
              >
                View on GitHub <ArrowRight className="size-3.5" />
              </a>
            </div>
          </motion.div>
        </div>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.9, delay: 0.55, ease: EASE }}
        className="border-t border-border bg-muted/40 p-3 md:p-8"
      >
        <HeroDemo />
      </motion.div>

      <dl className="grid grid-cols-2 border-t border-border">
        {STATS.map((stat) => (
          <div
            key={stat.caption}
            className="flex flex-col gap-3 border-border p-6 first:border-r md:p-8"
          >
            <dt className="text-xs leading-relaxed text-muted-foreground">
              {stat.caption}
            </dt>
            <dd className="order-first font-mono text-4xl font-medium tracking-tight tabular-nums text-foreground md:text-5xl">
              <CountUp to={stat.value} />
              <span className="text-muted-foreground">{stat.suffix}</span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
};
