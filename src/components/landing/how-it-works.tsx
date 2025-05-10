"use client";

import { useRef } from "react";
import { motion, useInView } from "motion/react";

const steps = [
  {
    number: "01",
    title: "Describe your project",
    description:
      "Tell the AI what you want to build. A landing page, a full-stack app, or a quick prototype — just describe it.",
  },
  {
    number: "02",
    title: "AI generates your code",
    description:
      "Claude writes production-ready code across multiple files. Review, edit, and iterate in real-time with the AI assistant.",
  },
  {
    number: "03",
    title: "Preview & deploy",
    description:
      "See your app running instantly in the browser. Push to GitHub or deploy when you're ready — no terminal needed.",
  },
];

export const LandingHowItWorks = () => {
  const sectionRef = useRef<HTMLDivElement>(null);
  const isInView = useInView(sectionRef, { once: true, amount: 0.2 });

  return (
    <section ref={sectionRef} className="relative py-32 md:py-40">
      {/* Subtle divider */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-24 h-px bg-gradient-to-r from-transparent via-border to-transparent" />

      <div className="max-w-5xl mx-auto px-6 md:px-8">
        {/* Section header */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          className="text-center mb-20"
        >
          <p className="text-xs uppercase tracking-[0.25em] text-brand font-mono mb-4">
            How it works
          </p>
          <h2 className="text-3xl md:text-5xl font-bold tracking-tight text-foreground">
            Three steps to shipping
          </h2>
        </motion.div>

        {/* Steps */}
        <div className="space-y-0">
          {steps.map((step, i) => (
            <motion.div
              key={step.number}
              initial={{ opacity: 0, x: -30 }}
              animate={isInView ? { opacity: 1, x: 0 } : {}}
              transition={{
                duration: 0.6,
                delay: i * 0.15 + 0.3,
                ease: [0.22, 1, 0.36, 1],
              }}
              className="group relative flex items-start gap-6 md:gap-10 py-10 border-b border-border/40 last:border-b-0"
            >
              {/* Number */}
              <span className="text-4xl md:text-5xl font-bold text-brand/20 group-hover:text-brand/40 transition-colors duration-500 font-mono shrink-0">
                {step.number}
              </span>

              {/* Content */}
              <div className="space-y-2 pt-2">
                <h3 className="text-xl md:text-2xl font-semibold text-foreground tracking-tight group-hover:text-brand transition-colors duration-300">
                  {step.title}
                </h3>
                <p className="text-muted-foreground leading-relaxed max-w-lg">
                  {step.description}
                </p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};
