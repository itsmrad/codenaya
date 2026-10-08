"use client";

import { useRef } from "react";
import { motion, useInView } from "motion/react";
import {
  Bot,
  Download,
  FolderGit2,
  KeyRound,
  MonitorPlay,
  Puzzle,
} from "lucide-react";
import { AGENT_MODELS } from "@/features/conversations/agent-models";

const features = [
  {
    icon: Bot,
    title: "AI agent with model choice",
    description: `Describe what you want and the agent writes and edits files across your project. Switch between ${AGENT_MODELS.length} models, including Claude, GPT and Gemini, and use Cmd+K for quick edits in the editor.`,
    span: "lg:col-span-2",
  },
  {
    icon: MonitorPlay,
    title: "Live preview & terminal",
    description:
      "Your app runs in a cloud sandbox with a live preview and a terminal. No local setup.",
    span: "lg:col-span-1",
  },
  {
    icon: FolderGit2,
    title: "GitHub import & export",
    description:
      "Start from any GitHub repository, then export your project to a new repo when it's ready.",
    span: "lg:col-span-1",
  },
  {
    icon: KeyRound,
    title: "Bring your own key",
    description:
      "Run the agent on your own OpenRouter, OpenAI or Anthropic key, or any OpenAI-compatible endpoint.",
    span: "lg:col-span-2",
  },
  {
    icon: Puzzle,
    title: "Skills & integrations",
    description:
      "Teach the agent reusable skills, and connect integrations whose actions wait for your approval.",
    span: "lg:col-span-2",
  },
  {
    icon: Download,
    title: "Download as ZIP",
    description:
      "Take the full source with you in one click, whenever you want.",
    span: "lg:col-span-1",
  },
];

export const LandingFeatures = () => {
  const sectionRef = useRef<HTMLDivElement>(null);
  const isInView = useInView(sectionRef, { once: true, amount: 0.2 });

  return (
    <section ref={sectionRef} className="relative py-14 md:py-20">
      <div className="max-w-6xl mx-auto px-6 md:px-8">
        {/* Section header */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          className="text-center mb-12 md:mb-16"
        >
          <p className="text-xs uppercase tracking-[0.25em] text-brand font-mono mb-4">
            Features
          </p>
          <h2 className="text-3xl md:text-5xl font-bold tracking-tight text-foreground">
            Everything you need to build
          </h2>
        </motion.div>

        {/* Bento Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-5">
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
              <div className="relative h-full p-6 md:p-8 rounded-xl border border-border/60 bg-card/50 transition-colors duration-200 hover:border-border">
                <div className="space-y-4">
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
