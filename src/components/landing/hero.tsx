"use client";

import { useRef } from "react";
import { motion, useInView } from "motion/react";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { GridPattern } from "./grid-pattern";
import { Noise } from "./noise";
import { PromptInputHero } from "./prompt-input-hero";

export const LandingHero = () => {
  const heroRef = useRef<HTMLDivElement>(null);
  const isInView = useInView(heroRef, { once: true, amount: 0.3 });
  const { user } = useUser();
  const router = useRouter();

  const targetUrl = user?.publicMetadata?.hasCompletedOnboarding ? "/" : "/onboarding";

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
      className="relative min-h-[100dvh] lg:h-[100dvh] lg:max-h-[100dvh] w-full overflow-hidden flex flex-col justify-center items-center pt-16 pb-8"
    >
      {/* Background layers */}
      <div className="absolute inset-0 bg-background" />

      {/* Subtle grid */}
      <GridPattern />

      {/* Noise texture */}
      <Noise />

      {/* Radial gradient spotlight — warm amber glow */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_50%_40%,rgba(232,130,79,0.08),transparent_70%)] dark:bg-[radial-gradient(ellipse_60%_50%_at_50%_40%,rgba(232,130,79,0.12),transparent_70%)]" />

      {/* Vignette */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,var(--background)_80%)] opacity-60" />

      {/* Content */}
      <div className="relative z-10 w-full max-w-4xl mx-auto px-4 sm:px-6 md:px-8 text-center my-auto flex flex-col items-center">
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate={isInView ? "visible" : "hidden"}
          className="w-full flex flex-col items-center space-y-3 sm:space-y-4 md:space-y-5"
        >
          {/* Badge */}
          <motion.div variants={fadeUp} className="flex justify-center">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-border/60 bg-card/50 backdrop-blur-sm text-[11px] sm:text-xs font-medium text-muted-foreground">
              <span className="size-1.5 rounded-full bg-brand animate-pulse" />
              AI-Powered Browser IDE
            </div>
          </motion.div>

          {/* Headline */}
          <div className="space-y-0.5 sm:space-y-1">
            {headline.map((line, i) => (
              <motion.h1
                key={i}
                variants={lineVariants}
                className="text-3xl sm:text-5xl md:text-6xl lg:text-[62px] font-bold tracking-tight leading-[1.08]"
              >
                <span className={
                  i === 0
                    ? "bg-gradient-to-r from-foreground via-foreground to-brand bg-clip-text text-transparent"
                    : "text-foreground"
                }>
                  {line}
                </span>
              </motion.h1>
            ))}
          </div>

          {/* Subtitle */}
          <motion.p
            variants={fadeUp}
            className="text-xs sm:text-sm md:text-base text-muted-foreground max-w-xl mx-auto leading-relaxed font-light"
          >
            A browser-based IDE with AI code generation, real-time collaboration,
            and instant preview. Write, run, and deploy — all in one place.
          </motion.p>

          {/* Prompt Input Box (Lovable inspired flow) */}
          <motion.div variants={fadeUp} className="w-full pt-1">
            <PromptInputHero />
          </motion.div>

          {/* Secondary Actions */}
          <motion.div variants={fadeUp} className="flex flex-col sm:flex-row items-center justify-center gap-2 sm:gap-4 pt-1">
            <button
              onClick={() => router.push(targetUrl)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors underline-offset-4 hover:underline cursor-pointer"
            >
              Or start with a blank workspace →
            </button>
            <span className="hidden sm:inline text-muted-foreground/30">•</span>
            <a
              href="https://github.com/itsmrad/codenaya"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors underline-offset-4 hover:underline"
            >
              View source on GitHub
            </a>
          </motion.div>
        </motion.div>
      </div>

      {/* Scroll indicator - anchored to bottom */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 2.0, duration: 0.8 }}
        className="absolute bottom-2 sm:bottom-3 left-1/2 -translate-x-1/2 flex items-center justify-center gap-3 z-20 pointer-events-none"
      >
        <div className="h-px w-8 sm:w-12 bg-gradient-to-r from-transparent to-border" />
        <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground/60 font-mono">
          Scroll
        </span>
        <div className="h-px w-8 sm:w-12 bg-gradient-to-l from-transparent to-border" />
      </motion.div>

      {/* Bottom fade */}
      <div className="absolute bottom-0 left-0 right-0 h-16 sm:h-20 bg-gradient-to-t from-background to-transparent pointer-events-none" />
    </section>
  );
};
