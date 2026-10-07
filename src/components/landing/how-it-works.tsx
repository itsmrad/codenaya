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
    <section ref={sectionRef} className="relative py-14 md:py-20">
      <div className="max-w-3xl mx-auto px-6 md:px-8">
        {/* Section header */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          className="text-center mb-8 md:mb-10"
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
              className="relative flex items-start gap-6 md:gap-10 py-8 md:py-10 border-b border-border/40 last:border-b-0 last:pb-0"
            >
              {/* Number */}
              <span className="text-4xl md:text-5xl font-bold text-brand/40 font-mono shrink-0">
                {step.number}
              </span>

              {/* Content */}
              <div className="space-y-2 pt-2">
                <h3 className="text-xl md:text-2xl font-semibold text-foreground tracking-tight">
                  {step.title}
                </h3>
                <p className="text-muted-foreground leading-relaxed">
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
