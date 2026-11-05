"use client";

import { motion, useReducedMotion } from "motion/react";
import { Check, Download, FolderGit2 } from "lucide-react";

import { SectionHeader } from "./section-header";

const CODE_LINES = [
  { indent: 0, width: 62, tone: "bg-brand/50" },
  { indent: 1, width: 48, tone: "bg-foreground/15" },
  { indent: 1, width: 70, tone: "bg-foreground/15" },
  { indent: 2, width: 40, tone: "bg-sky-500/30" },
  { indent: 2, width: 55, tone: "bg-foreground/15" },
  { indent: 1, width: 30, tone: "bg-emerald-500/30" },
  { indent: 0, width: 18, tone: "bg-foreground/15" },
];

const STEPS = [
  {
    title: "Describe it.",
    body: "Tell the agent what you want, or import a GitHub repo to start from. A landing page, a full-stack app or a quick prototype.",
    visual: <DescribeVisual />,
  },
  {
    title: "The agent writes it.",
    body: "Pick a model and the agent writes code across your files. Review it, edit it, and keep iterating in the chat.",
    visual: <CodeVisual />,
  },
  {
    title: "Run it and ship it.",
    body: "Your app runs in a live preview. Export it to a new GitHub repo or download a ZIP when it's ready.",
    visual: <ShipVisual />,
  },
];

export const LandingHowItWorks = () => (
  <section id="how-it-works" className="border-b border-border">
    <SectionHeader
      index={1}
      label="How it works"
      title="Three moves."
      accent="No setup."
      description="Codenaya runs in the browser. There is nothing to install, so the first prompt is the first step."
    />
    <ol className="grid border-t border-border md:grid-cols-3">
      {STEPS.map((step, i) => (
        <li
          key={step.title}
          className="spotlight flex flex-col border-border not-last:border-b md:not-last:border-r md:not-last:border-b-0"
        >
          <div className="relative h-56 overflow-hidden border-b border-border bg-muted/30">{step.visual}</div>
          <div className="flex flex-1 flex-col gap-3 p-6 md:p-8">
            <span className="font-mono text-[11px] text-brand-text">0{i + 1}</span>
            <p className="text-[15px] leading-relaxed text-muted-foreground">
              <strong className="font-semibold text-foreground">{step.title}</strong> {step.body}
            </p>
          </div>
        </li>
      ))}
    </ol>
  </section>
);

/** Looping animations play only without reduced motion; otherwise they show their end state. */
const useLoop = () => !useReducedMotion();

function DescribeVisual() {
  const loop = useLoop();
  const text = "A habit tracker with streaks";
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div className="w-full max-w-64 rounded-md border border-border bg-card p-3 shadow-sm">
        <div className="flex items-center font-mono text-[12px] text-foreground">
          <motion.span
            className="overflow-hidden whitespace-nowrap"
            initial={{ width: loop ? "0ch" : `${text.length}ch` }}
            whileInView={{ width: `${text.length}ch` }}
            transition={loop ? { duration: 2.2, ease: "linear", repeat: Infinity, repeatDelay: 1.6 } : undefined}
          >
            {text}
          </motion.span>
          <span className="ml-0.5 h-3.5 w-px motion-safe:animate-pulse bg-foreground" />
        </div>
        <div className="mt-3 flex items-center justify-between">
          <span className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            <FolderGit2 className="size-3" /> or import a repo
          </span>
          <span className="size-6 rounded bg-brand shadow-[inset_0_-3px_6px_rgb(0_0_0/0.15)]" />
        </div>
      </div>
    </div>
  );
}

function CodeVisual() {
  const loop = useLoop();
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div className="w-full max-w-64 rounded-md border border-border bg-card p-3 shadow-sm">
        <div className="mb-3 flex gap-1.5 font-mono text-[10px]">
          <span className="rounded bg-brand/10 px-1.5 py-0.5 text-brand-text">habits.tsx</span>
          <span className="px-1.5 py-0.5 text-muted-foreground">streak.ts</span>
        </div>
        <div className="space-y-2">
          {CODE_LINES.map((line, i) => (
            <motion.div
              key={i}
              className={`h-2 rounded-full ${line.tone}`}
              style={{ marginLeft: line.indent * 12, width: `${line.width}%`, transformOrigin: "left" }}
              initial={{ scaleX: loop ? 0 : 1 }}
              whileInView={{ scaleX: 1 }}
              transition={
                loop
                  ? { duration: 0.35, delay: i * 0.25, repeat: Infinity, repeatDelay: CODE_LINES.length * 0.25 + 1.5 }
                  : undefined
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ShipVisual() {
  const loop = useLoop();
  return (
    <div className="absolute inset-0 flex items-center justify-center gap-3 p-6">
      <div className="flex w-full max-w-64 flex-col gap-2">
        {[
          { icon: FolderGit2, label: "Export to GitHub", detail: "habit-tracker" },
          { icon: Download, label: "Download ZIP", detail: "48 KB" },
        ].map(({ icon: Icon, label, detail }, i) => (
          <motion.div
            key={label}
            className="flex items-center gap-2.5 rounded-md border border-border bg-card px-3 py-2.5 text-[12px] shadow-sm"
            initial={loop ? { opacity: 0, y: 8 } : false}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.2 + i * 0.2 }}
          >
            <Icon className="size-3.5 text-muted-foreground" />
            <span className="font-medium text-foreground">{label}</span>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">{detail}</span>
            <Check className="size-3.5 text-emerald-600" />
          </motion.div>
        ))}
        <div className="flex items-center gap-2 px-1 font-mono text-[10px] text-muted-foreground">
          <span className="size-1.5 motion-safe:animate-pulse rounded-full bg-emerald-500" /> Preview running
        </div>
      </div>
    </div>
  );
}
