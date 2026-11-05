"use client";

import { motion } from "motion/react";
import { ArrowRight } from "lucide-react";
import { GridPattern } from "./grid-pattern";
import { LandingPromptComposer } from "./landing-prompt-composer";
import { Noise } from "./noise";

export const LandingHero = () => {

  const headline = ["Build with AI.", "Ship from your browser."];

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.12,
        delayChildren: 0.4,
      },
    },
  };

  const lineVariants = {
    hidden: { opacity: 0, y: 60, filter: "blur(10px)" },
    visible: {
      opacity: 1,
      y: 0,
      filter: "blur(0px)",
      transition: {
        duration: 0.8,
        ease: [0.22, 1, 0.36, 1] as const,
      },
    },
  };

  const fadeUp = {
    hidden: { opacity: 0, y: 30 },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        duration: 0.7,
        ease: [0.22, 1, 0.36, 1] as const,
      },
    },
  };

  return (
    <section
      className="relative w-full overflow-hidden pt-28 pb-16 md:pt-40 md:pb-20"
    >
      {/* Subtle grid */}
      <GridPattern />

      {/* Noise texture */}
      <Noise />

      {/* Content */}
      <div className="relative z-10 max-w-5xl mx-auto px-6 md:px-8 text-center">
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate="visible"
          className="space-y-8"
        >

          {/* Headline */}
          <div className="space-y-2">
            {headline.map((line, i) => (
              <motion.h1
                key={i}
                variants={lineVariants}
                className="text-[2.5rem] sm:text-6xl lg:text-7xl font-bold tracking-tighter leading-[1.05] text-foreground"
              >
                {line}
              </motion.h1>
            ))}
          </div>

          {/* Subtitle */}
          <motion.p
            variants={fadeUp}
            className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed font-light"
          >
            A browser IDE with an AI agent that writes your code, a live preview
            to run it, and GitHub export when it&apos;s done. On desktop or phone.
          </motion.p>

          {/* Prompt: typing comes first, sign-up second */}
          <motion.div variants={fadeUp} className="mx-auto max-w-2xl pt-4">
            <LandingPromptComposer showStarters className="text-left" />
            <a
              href="https://github.com/itsmrad/codenaya"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-5 inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              View on GitHub
              <ArrowRight className="size-3.5" />
            </a>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
};
