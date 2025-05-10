"use client";

import { useRef } from "react";
import { motion, useInView } from "motion/react";
import { ArrowRight } from "lucide-react";
import { SignUpButton } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
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
      className="relative min-h-screen w-full overflow-hidden flex items-center justify-center pt-16"
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
                className="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-bold tracking-tighter leading-[1.05]"
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
            className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed font-light"
          >
            A browser-based IDE with AI code generation, real-time collaboration,
            and instant preview. Write, run, and deploy — all in one place.
          </motion.p>

          {/* CTA */}
          <motion.div variants={fadeUp} className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4">
            <SignUpButton mode="modal">
              <motion.div whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}>
                <Button
                  size="lg"
                  className="h-12 px-8 text-base font-medium bg-brand text-white hover:bg-brand/90 rounded-full shadow-xl shadow-brand/25 gap-2 group"
                >
                  Start Building
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                </Button>
              </motion.div>
            </SignUpButton>
            <motion.a
              href="https://github.com/itsmrad/codenaya"
              target="_blank"
              rel="noopener noreferrer"
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
            >
              <Button
                variant="outline"
                size="lg"
                className="h-12 px-8 text-base font-medium rounded-full border-border/60 hover:border-border"
              >
                View on GitHub
              </Button>
            </motion.a>
          </motion.div>

          {/* Scroll indicator */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 2.2, duration: 0.8 }}
            className="flex items-center justify-center gap-4 pt-16"
          >
            <div className="h-px w-12 bg-gradient-to-r from-transparent to-border" />
            <span className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground/60 font-mono">
              Scroll
            </span>
            <div className="h-px w-12 bg-gradient-to-l from-transparent to-border" />
          </motion.div>
        </motion.div>
      </div>

      {/* Bottom fade */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-background to-transparent" />
    </section>
  );
};
