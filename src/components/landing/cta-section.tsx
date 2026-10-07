"use client";

import { useRef } from "react";
import { motion, useInView } from "motion/react";
import { LandingPromptComposer } from "./landing-prompt-composer";

export const LandingCTA = () => {
  const sectionRef = useRef<HTMLDivElement>(null);
  const isInView = useInView(sectionRef, { once: true, amount: 0.4 });

  return (
    <section ref={sectionRef} className="relative py-14 md:py-20 overflow-hidden">
      <div className="relative z-10 max-w-3xl mx-auto px-6 md:px-8 text-center">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
          className="space-y-8"
        >
          <h2 className="text-4xl md:text-6xl font-bold tracking-tighter text-foreground">
            Ready to build?
          </h2>
          <p className="text-lg text-muted-foreground max-w-xl mx-auto leading-relaxed">
            Join developers who are shipping faster with AI-powered coding.
            No setup required — start building in seconds.
          </p>
          <LandingPromptComposer showStarters className="pt-4 text-left" />
        </motion.div>
      </div>
    </section>
  );
};
