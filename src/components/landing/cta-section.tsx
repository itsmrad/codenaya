"use client";

import { motion } from "motion/react";

import { GridCross } from "./section-header";
import { LandingPromptComposer } from "./landing-prompt-composer";

export const LandingCTA = () => {
  return (
    <section className="relative overflow-hidden border-b border-border">
      {/* Dotted field, fading out from the centre */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(var(--color-foreground)_1px,transparent_1px)] [background-size:18px_18px] opacity-[0.12] [mask-image:radial-gradient(ellipse_55%_60%_at_50%_45%,black,transparent)]"
      />
      <GridCross className="-top-[5px] -left-[5px]" />
      <GridCross className="-top-[5px] -right-[5px]" />

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.4 }}
        transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
        className="relative mx-auto max-w-3xl px-6 py-24 text-center md:py-32"
      >
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">[ Get started ]</p>
        <h2 className="mt-5 text-5xl font-medium leading-[1.04] tracking-[-0.03em] text-foreground md:text-7xl">
          Start with <span className="text-brand">one prompt</span>
        </h2>
        <p className="mx-auto mt-5 max-w-lg text-lg leading-relaxed text-pretty text-muted-foreground">
          300 free credits a month, and nothing to install.
        </p>
        <LandingPromptComposer className="mt-10 text-left" />
      </motion.div>
    </section>
  );
};
