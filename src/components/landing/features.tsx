"use client";

import { useRef } from "react";
import { motion, useInView } from "motion/react";
import { Sparkles, GitBranch, Play, Users } from "lucide-react";

const features = [
  {
    icon: Sparkles,
    title: "AI Code Generation",
    description:
      "Claude-powered suggestions, quick edits with Cmd+K, and a conversational AI assistant that understands your entire codebase.",
    span: "md:col-span-2",
  },
  {
    icon: Play,
    title: "In-Browser Execution",
    description:
      "Run your code instantly with WebContainer. No setup, no local environment — just write and see results.",
    span: "md:col-span-1",
  },
  {
    icon: GitBranch,
    title: "GitHub Integration",
    description:
      "Import repos, push changes, and manage branches directly from your browser. Your workflow, streamlined.",
    span: "md:col-span-1",
  },
  {
    icon: Users,
    title: "Real-time Collaboration",
    description:
      "Convex-powered real-time sync. Every keystroke, every file change — instantly reflected across all collaborators.",
    span: "md:col-span-2",
  },
];

export const LandingFeatures = () => {
  const sectionRef = useRef<HTMLDivElement>(null);
  const isInView = useInView(sectionRef, { once: true, amount: 0.2 });

  return (
    <section ref={sectionRef} className="relative py-32 md:py-40">
      <div className="max-w-6xl mx-auto px-6 md:px-8">
        {/* Section header */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          className="text-center mb-16 md:mb-20"
        >
          <p className="text-xs uppercase tracking-[0.25em] text-brand font-mono mb-4">
            Features
          </p>
          <h2 className="text-3xl md:text-5xl font-bold tracking-tight text-foreground">
            Everything you need to build
          </h2>
        </motion.div>

        {/* Bento Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-5">
          {features.map((feature, i) => (
            <motion.div
              key={feature.title}
              initial={{ opacity: 0, y: 40 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{
                duration: 0.6,
                delay: i * 0.1 + 0.2,
                ease: [0.22, 1, 0.36, 1],
              }}
              className={`${feature.span} group relative`}
            >
              <div className="relative h-full p-6 md:p-8 rounded-2xl border border-border/60 bg-card/50 backdrop-blur-sm overflow-hidden transition-all duration-500 hover:border-brand/30 hover:shadow-lg hover:shadow-brand/5">
                {/* Hover glow */}
                <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 bg-[radial-gradient(ellipse_at_top_left,rgba(232,130,79,0.05),transparent_60%)]" />

                <div className="relative z-10 space-y-4">
                  <div className="inline-flex items-center justify-center size-10 rounded-xl bg-brand/10 text-brand">
                    <feature.icon className="size-5" />
                  </div>
                  <h3 className="text-lg font-semibold text-foreground tracking-tight">
                    {feature.title}
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {feature.description}
                  </p>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};
