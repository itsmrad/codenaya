"use client";

import { useEffect, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Bot, Download, FolderGit2, KeyRound, MonitorPlay, Puzzle, type LucideIcon } from "lucide-react";

import { AGENT_MODELS } from "@/features/conversations/agent-models";
import { cn } from "@/lib/utils";
import { SectionHeader } from "./section-header";

const PICKER_MODELS = AGENT_MODELS.slice(0, 5);

type Feature = {
  icon: LucideIcon;
  tag: string;
  title: string;
  body: string;
  visual: ReactNode;
  wide?: boolean;
};

const FEATURES: Feature[] = [
  {
    icon: Bot,
    tag: "AI agent with model choice",
    title: "Model choice.",
    body: "The agent writes and edits files across your project. Switch between models, including Claude, GPT and Gemini, and use Cmd+K for quick edits.",
    visual: <ModelPicker />,
    wide: true,
  },
  {
    icon: MonitorPlay,
    tag: "Live preview & terminal",
    title: "Live preview & terminal.",
    body: "Your app runs in a cloud sandbox with a preview and a terminal. No local setup.",
    visual: <Terminal />,
  },
  {
    icon: FolderGit2,
    tag: "GitHub import & export",
    title: "Import & export.",
    body: "Start from any GitHub repository, then export to a new repo when it's ready.",
    visual: <RepoFlow />,
  },
  {
    icon: Puzzle,
    tag: "Skills & integrations",
    title: "Teach it once.",
    body: "Write reusable skills as a SKILL.md and type / to apply one, and connect services like Supabase, Stripe and Linear.",
    visual: <Skills />,
    wide: true,
  },
  {
    icon: KeyRound,
    tag: "Bring your own key",
    title: "Your own key.",
    body: "Run the agent on your OpenRouter, OpenAI, Anthropic or Groq key, or any OpenAI-compatible endpoint.",
    visual: <KeyField />,
    wide: true,
  },
  {
    icon: Download,
    tag: "Download as ZIP",
    title: "Download as ZIP.",
    body: "Take the full source with you in one click, whenever you want.",
    visual: <ZipBar />,
  },
];

export const LandingFeatures = () => (
  <section className="border-b border-border">
    <SectionHeader
      index={2}
      label="Features"
      title="Everything you need"
      accent="to ship."
      description="An agent, a sandbox and your code, in one tab. Every part is built to get out of your way."
    />
    <div className="grid border-t border-border md:grid-cols-2 lg:grid-cols-3">
      {FEATURES.map(({ icon: Icon, tag, title, body, visual, wide }, i) => (
        <motion.article
          key={tag}
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true, amount: 0.3 }}
          transition={{ duration: 0.6, delay: (i % 3) * 0.08 }}
          className={cn(
            // Two cells per row (one wide from lg), so every odd cell ends its row.
            "spotlight group flex flex-col border-border border-b last:border-b-0 md:border-r",
            wide && "lg:col-span-2",
            i % 2 === 1 && "md:border-r-0",
            i >= FEATURES.length - 2 && "md:border-b-0",
          )}
        >
          <div className="flex flex-col gap-3 p-6 md:p-8">
            <h3 className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
              <Icon className="size-3.5" /> {tag}
            </h3>
            <p className="max-w-md text-[15px] leading-relaxed text-muted-foreground">
              <strong className="font-semibold text-foreground">{title}</strong> {body}
            </p>
          </div>
          <div className="relative mt-auto flex h-52 items-center justify-center overflow-hidden border-t border-border bg-muted/30 p-6 transition-colors group-hover:bg-brand/[0.04]">
            {visual}
          </div>
        </motion.article>
      ))}
    </div>
  </section>
);

/** Cycles through `count` items every `ms`, unless the user prefers reduced motion. */
const useCycle = (count: number, ms: number) => {
  const reduceMotion = useReducedMotion();
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (reduceMotion) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % count), ms);
    return () => clearInterval(id);
  }, [count, ms, reduceMotion]);
  return index;
};

const Panel = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cn("w-full max-w-sm rounded-md border border-border bg-card shadow-sm", className)}>{children}</div>
);

function ModelPicker() {
  const active = useCycle(PICKER_MODELS.length, 1400);
  return (
    <Panel className="p-1.5">
      {PICKER_MODELS.map((model, i) => (
        <div
          key={model.id}
          className={cn(
            "relative flex items-center justify-between rounded px-3 py-1.5 text-[12px] transition-colors duration-300",
            i === active ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {i === active && (
            <motion.span layoutId="model-picker" className="absolute inset-0 rounded bg-brand/10" />
          )}
          <span className="relative">{model.label}</span>
          <span className="relative font-mono text-[10px] uppercase tracking-[0.12em]">{model.provider}</span>
        </div>
      ))}
    </Panel>
  );
}

const TERMINAL_LINES = ["$ npm install", "added 214 packages in 6s", "$ npm run dev", "▲ Ready on http://localhost:3000"];

function Terminal() {
  const shown = useCycle(TERMINAL_LINES.length + 2, 700);
  const reduceMotion = useReducedMotion();
  const count = reduceMotion ? TERMINAL_LINES.length : Math.min(shown + 1, TERMINAL_LINES.length);
  return (
    <Panel className="bg-[#111110] p-3 font-mono text-[11px] leading-5">
      {TERMINAL_LINES.slice(0, count).map((line, i) => (
        <div key={line} className={i === 3 ? "text-emerald-400" : line.startsWith("$") ? "text-white" : "text-white/45"}>
          {line}
        </div>
      ))}
      <span className="inline-block h-3 w-1.5 motion-safe:animate-pulse bg-white/70" />
    </Panel>
  );
}

function RepoFlow() {
  return (
    <div className="flex w-full max-w-sm items-center gap-2 font-mono text-[11px]">
      <Panel className="flex-1 px-3 py-2 text-muted-foreground">
        <FolderGit2 className="mb-1 size-3.5 text-foreground" />
        you/repo
      </Panel>
      <div className="relative h-px w-10 overflow-hidden bg-border">
        <span className="absolute inset-y-0 w-4 animate-[landing-flow_1.6s_linear_infinite] bg-brand" />
      </div>
      <Panel className="flex-1 border-brand/40 px-3 py-2 text-foreground">
        <span className="mb-1 block size-3.5 rounded-sm bg-brand" />
        codenaya
      </Panel>
    </div>
  );
}

const SKILLS = ["write-tests", "tailwind-ui", "seo-audit"];

function Skills() {
  const active = useCycle(SKILLS.length, 1500);
  return (
    <Panel className="max-w-md p-3">
      <div className="rounded border border-border px-3 py-2 font-mono text-[12px] text-foreground">
        /{SKILLS[active]}
        <span className="ml-0.5 inline-block h-3 w-px translate-y-0.5 motion-safe:animate-pulse bg-foreground" />
      </div>
      <div className="mt-2 flex flex-col gap-0.5">
        {SKILLS.map((skill, i) => (
          <div
            key={skill}
            className={cn(
              "flex items-center justify-between rounded px-3 py-1.5 font-mono text-[11px] transition-colors duration-300",
              i === active ? "bg-brand/10 text-brand-text" : "text-muted-foreground",
            )}
          >
            /{skill}
            <span className="text-[10px]">SKILL.md</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

const KEY_PROVIDERS = ["OpenRouter", "OpenAI", "Anthropic", "Groq", "Custom"];

function KeyField() {
  const active = useCycle(KEY_PROVIDERS.length, 1600);
  return (
    <Panel className="max-w-md p-4">
      <div className="flex flex-wrap gap-1">
        {KEY_PROVIDERS.map((provider, i) => (
          <span
            key={provider}
            className={cn(
              "rounded px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em] transition-colors duration-300",
              i === active ? "bg-foreground text-background" : "text-muted-foreground",
            )}
          >
            {provider}
          </span>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2 rounded border border-border px-3 py-2 font-mono text-[12px] text-foreground">
        <KeyRound className="size-3.5 text-muted-foreground" />
        ••••3f9a
        <span className="ml-auto text-[10px] text-emerald-600">no credits</span>
      </div>
    </Panel>
  );
}

function ZipBar() {
  return (
    <Panel className="p-4">
      <div className="flex items-center justify-between font-mono text-[11px] text-foreground">
        habit-tracker.zip <span className="text-muted-foreground">48 KB</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
        <span className="block h-full w-full origin-left animate-[landing-fill_2.4s_ease-in-out_infinite] rounded-full bg-brand" />
      </div>
    </Panel>
  );
}
