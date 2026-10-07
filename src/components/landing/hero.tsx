"use client";

import { useRef } from "react";
import Link from "next/link";
import { motion, useInView } from "motion/react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SIGN_UP_URL } from "@/features/auth/constants";
import { GridPattern } from "./grid-pattern";
import { Noise } from "./noise";

export const LandingHero = () => {
  const heroRef = useRef<HTMLDivElement>(null);
  const isInView = useInView(heroRef, { once: true, amount: 0.3 });

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
      ref={heroRef}
      className="relative w-full overflow-hidden pt-28 pb-16 md:pt-40 md:pb-20"
    >
      {/* Background layers */}
      <div className="absolute inset-0 bg-background" />

      {/* Subtle grid */}
      <GridPattern />

      {/* Noise texture */}
      <Noise />

      {/* Vignette */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,var(--background)_80%)] opacity-60" />

      {/* Content */}
      <div className="relative z-10 max-w-5xl mx-auto px-6 md:px-8 text-center">
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate={isInView ? "visible" : "hidden"}
          className="space-y-8"
        >
          {/* Badge */}
          <motion.div variants={fadeUp} className="flex justify-center">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-border/60 bg-card/50 backdrop-blur-sm text-xs font-medium text-muted-foreground">
              <span className="size-1.5 rounded-full bg-brand animate-pulse" />
              AI-Powered Browser IDE
            </div>
          </motion.div>

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
            A browser-based IDE with AI code generation, real-time collaboration,
            and instant preview. Write, run, and deploy — all in one place.
          </motion.p>

          {/* CTA */}
          <motion.div variants={fadeUp} className="mx-auto flex w-full max-w-xs flex-col items-stretch justify-center gap-3 pt-4 sm:max-w-none sm:flex-row sm:items-center">
            <Button
              asChild
              size="lg"
              className="w-full sm:w-auto h-12 px-8 text-base font-medium bg-brand text-brand-foreground hover:bg-brand/90 rounded-full gap-2 group"
            >
              <Link href={SIGN_UP_URL}>
                Start Building
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </Button>
            <motion.a
              href="https://github.com/itsmrad/codenaya"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button
                variant="outline"
                size="lg"
                className="w-full sm:w-auto h-12 px-8 text-base font-medium rounded-full border-border/60 hover:border-border"
              >
                View on GitHub
              </Button>
            </motion.a>
          </motion.div>
        </motion.div>
      </div>

      {/* Bottom fade */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-background to-transparent" />
    </section>
  );
};
