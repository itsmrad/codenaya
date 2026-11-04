"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Bot,
  Terminal,
  Sparkles,
  Globe,
  Copy,
  Check,
  Play,
  RotateCcw,
  Layers,
  FileCode,
  ArrowRight,
} from "lucide-react";
import Link from "next/link";
import { SIGN_UP_URL } from "@/features/auth/constants";

type PlaygroundMode = "agent" | "sandbox" | "quick-edit" | "firecrawl-docs";

interface ModeData {
  id: PlaygroundMode;
  name: string;
  badge: string;
  icon: typeof Bot;
  prompt: string;
  description: string;
  files: { name: string; status: "created" | "modified" | "read" }[];
  code: string;
  terminalLog: string[];
  executionTime: string;
  tokenCount: string;
  model: string;
}

const MODES: Record<PlaygroundMode, ModeData> = {
  agent: {
    id: "agent",
    name: "Multi-File Agent",
    badge: "Autonomous",
    icon: Bot,
    prompt: "Create a real-time collaborative Kanban board with task filters, drag & drop, and Convex mutations.",
    description: "The autonomous agent breaks down user intent into file operations, writes type-safe TypeScript, and handles state across components and database schemas.",
    files: [
      { name: "src/components/kanban-board.tsx", status: "created" },
      { name: "src/components/kanban-column.tsx", status: "created" },
      { name: "convex/tasks.ts", status: "created" },
      { name: "convex/schema.ts", status: "modified" },
    ],
    code: `// convex/tasks.ts
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const listByProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    return await ctx.db
      .query("tasks")
      .withIndex("by_project_status", (q) => q.eq("projectId", projectId))
      .collect();
  },
});

export const updateStatus = mutation({
  args: { taskId: v.id("tasks"), status: v.string(), order: v.number() },
  handler: async (ctx, { taskId, status, order }) => {
    await ctx.db.patch(taskId, { status, order, updatedAt: Date.now() });
  },
});`,
    terminalLog: [
      "[agent] Analyzing workspace dependency graph...",
      "[agent] Tool call: read_file('convex/schema.ts')",
      "[agent] Schema verified. Adding 'tasks' table index.",
      "[agent] Tool call: write_file('convex/tasks.ts')",
      "[agent] Tool call: write_file('src/components/kanban-board.tsx')",
      "[build-gate] TypeScript validation: 0 errors found.",
      "[agent] Finished in 1.18s. All files ready.",
    ],
    executionTime: "1.18s",
    tokenCount: "1,420 tokens",
    model: "Claude Sonnet 5.5",
  },
  sandbox: {
    id: "sandbox",
    name: "Live Sandbox & Preview",
    badge: "Cloud MicroVM",
    icon: Terminal,
    prompt: "Boot Vite + React 19 dev server with HMR live preview in the browser.",
    description: "Your code compiles and runs immediately in an isolated in-browser cloud microVM. Inspect console logs, network calls, and interact with the rendered preview.",
    files: [
      { name: "src/App.tsx", status: "modified" },
      { name: "vite.config.ts", status: "read" },
      { name: "package.json", status: "read" },
    ],
    code: `// src/App.tsx — Hot Reload Active
import { useState } from "react";
import { KanbanBoard } from "./components/kanban-board";

export default function App() {
  const [activeView, setActiveView] = useState("board");

  return (
    <div className="min-h-screen bg-neutral-950 text-white p-6">
      <header className="flex justify-between items-center mb-6">
        <h1 className="text-xl font-bold tracking-tight">Project Sprint #14</h1>
        <div className="flex gap-2">
          <span className="px-2.5 py-1 text-xs bg-emerald-500/20 text-emerald-400 rounded-full font-mono">
            ● Dev Server Active (Port 5173)
          </span>
        </div>
      </header>
      <KanbanBoard view={activeView} />
    </div>
  );
}`,
    terminalLog: [
      "$ npm run dev",
      "> project@0.1.0 dev",
      "> vite --port 5173",
      "",
      "  VITE v6.1.0  ready in 284 ms",
      "",
      "  ➜  Local:   http://localhost:5173/",
      "  ➜  Network: use --host to expose",
      "  ➜  press h + enter to show help",
      "[hmr] connected to client",
      "[hmr] (x2) src/components/kanban-board.tsx updated in 42ms",
    ],
    executionTime: "284ms boot",
    tokenCount: "Hot reload active",
    model: "In-Browser MicroVM",
  },
  "quick-edit": {
    id: "quick-edit",
    name: "Cmd+K Quick Edit",
    badge: "Inline AI",
    icon: Sparkles,
    prompt: "Refactor this component to add optimistic UI updates and keyboard shortcuts.",
    description: "Highlight any section of code in the CodeMirror editor and press Cmd+K. The AI generates precise line-by-line diffs that you can inspect, accept, or reject.",
    files: [
      { name: "src/hooks/use-tasks.ts", status: "modified" },
    ],
    code: `@@ -14,8 +14,14 @@
 export function useOptimisticTask(initialTask: Task) {
-  const [task, setTask] = useState(initialTask);
+  const [task, setTask] = useState(initialTask);
+  const [isPending, startTransition] = useTransition();
 
   const moveTask = async (newColumn: string) => {
-    await api.tasks.update({ id: task.id, status: newColumn });
+    // Optimistic UI update before server roundtrip
+    startTransition(() => {
+      setTask((prev) => ({ ...prev, status: newColumn }));
+    });
+    await api.tasks.update({ id: task.id, status: newColumn });
   };`,
    terminalLog: [
      "[quick-edit] Received selection: L14-L22 (8 lines)",
      "[quick-edit] Context loaded: imports, exports, type definitions",
      "[quick-edit] Prompt: 'add optimistic UI updates and useTransition'",
      "[quick-edit] Generated diff with 6 additions, 2 deletions",
      "[quick-edit] Syntax valid. Ready for approval.",
    ],
    executionTime: "0.85s",
    tokenCount: "480 tokens",
    model: "Gemini 3.8 Flash",
  },
  "firecrawl-docs": {
    id: "firecrawl-docs",
    name: "Live Docs via Firecrawl",
    badge: "RAG Engine",
    icon: Globe,
    prompt: "Use Firecrawl to fetch live documentation for '@mendable/firecrawl-js' and implement search extraction.",
    description: "Codenaya integrates Firecrawl under the hood to scrape and ingest live documentation URLs directly into the agent's context window. Always code against the latest SDK releases.",
    files: [
      { name: "src/lib/firecrawl.ts", status: "read" },
      { name: "src/lib/extract-docs.ts", status: "created" },
    ],
    code: `// src/lib/extract-docs.ts — Powered by Firecrawl
import Firecrawl from "@mendable/firecrawl-js";

const firecrawl = new Firecrawl({ 
  apiKey: process.env.FIRECRAWL_API_KEY 
});

export async function ingestLiveDocs(targetUrl: string) {
  // Firecrawl scrapes the URL to clean, LLM-ready markdown
  const result = await firecrawl.scrape(targetUrl, {
    formats: ["markdown"],
    onlyMainContent: true,
  });

  return {
    markdown: result.markdown,
    metadata: result.metadata,
  };
}`,
    terminalLog: [
      "[firecrawl] Ingesting URL: https://docs.firecrawl.dev/api-reference",
      "[firecrawl] Status: 200 OK (Clean markdown extracted: 3,420 bytes)",
      "[firecrawl] Injected live API schema into agent memory buffer",
      "[agent] Writing code using verified SDK types (v4.21+)",
      "[agent] Zero hallucinated methods. Compile check passed.",
    ],
    executionTime: "1.42s scrape",
    tokenCount: "3,890 tokens",
    model: "Firecrawl + Claude Sonnet 5.5",
  },
};

export const LandingPlayground = () => {
  const [activeMode, setActiveMode] = useState<PlaygroundMode>("agent");
  const [activeTab, setActiveTab] = useState<"code" | "preview" | "terminal">("code");
  const [copied, setCopied] = useState(false);
  const [demoClicks, setDemoClicks] = useState(3);

  const current = MODES[activeMode];

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(current.code);
    } catch {
      // Denied, or no clipboard outside a secure context: don't claim success.
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section aria-label="Interactive IDE Studio" className="relative py-14 md:py-24 overflow-hidden">
      <div className="max-w-6xl mx-auto px-6 md:px-8">
        {/* Section Heading */}
        <div className="text-center mb-10 md:mb-14">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-brand/20 bg-brand/10 text-xs font-mono text-brand-text mb-4">
            <span className="size-1.5 rounded-full bg-brand animate-pulse motion-reduce:animate-none" />
            Interactive Developer Studio
          </div>
          <h2 className="text-3xl md:text-5xl font-bold tracking-tight text-foreground">
            Experience the IDE in action
          </h2>
          <p className="mt-3 text-base md:text-lg text-muted-foreground max-w-2xl mx-auto">
            Test how Codenaya orchestrates multi-file agents, runs cloud microVM sandboxes, and ingests live documentation with Firecrawl.
          </p>
        </div>

        {/* Mode Selector Tabs (Firecrawl inspired) */}
        <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3 mb-8">
          {(Object.keys(MODES) as PlaygroundMode[]).map((modeKey) => {
            const mode = MODES[modeKey];
            const isActive = activeMode === modeKey;
            return (
              <button
                key={modeKey}
                type="button"
                aria-pressed={isActive}
                onClick={() => {
                  setActiveMode(modeKey);
                  setActiveTab(modeKey === "sandbox" ? "preview" : "code");
                }}
                className={`group relative flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-medium transition-all duration-200 border ${
                  isActive
                    ? "bg-foreground text-background border-foreground shadow-md shadow-foreground/10"
                    : "bg-card text-muted-foreground border-border hover:text-foreground hover:border-border hover:bg-muted"
                }`}
              >
                <mode.icon className={`size-4 ${isActive ? "text-brand" : "text-muted-foreground group-hover:text-foreground"}`} />
                <span>{mode.name}</span>
                <span
                  className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded-md ${
                    isActive
                      ? "bg-background/20 text-background"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {mode.badge}
                </span>
              </button>
            );
          })}
        </div>

        {/* Studio Window Card */}
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
          {/* Top Window Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border bg-muted">
            {/* Window Dots & Context info */}
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <div className="size-3 rounded-full bg-red-500/80" />
                <div className="size-3 rounded-full bg-yellow-500/80" />
                <div className="size-3 rounded-full bg-green-500/80" />
              </div>
              <span className="hidden sm:inline-block h-3.5 w-px bg-border/60" />
              <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
                <span className="font-semibold text-foreground">{current.name}</span>
                <span>•</span>
                <span>{current.model}</span>
              </div>
            </div>

            {/* Metrics Pills */}
            <div className="flex items-center gap-2 sm:gap-3 text-xs font-mono">
              <span className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-card border border-border/60 text-muted-foreground">
                <span className="size-1.5 rounded-full bg-emerald-500" />
                {current.executionTime}
              </span>
              <span className="hidden sm:inline-flex px-2.5 py-1 rounded-full bg-card border border-border/60 text-muted-foreground">
                {current.tokenCount}
              </span>
              <button
                onClick={handleCopy}
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors text-xs font-medium cursor-pointer"
                title="Copy code snippet"
              >
                {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
                <span>{copied ? "Copied" : "Copy"}</span>
              </button>
            </div>
          </div>

          {/* User Prompt Banner */}
          <div className="px-5 py-3 border-b border-border bg-card flex items-start sm:items-center gap-3">
            <div className="inline-flex items-center justify-center size-6 rounded-md bg-brand/15 text-brand shrink-0 mt-0.5 sm:mt-0">
              <Sparkles className="size-3.5" />
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider block">Developer Prompt</span>
              <p className="text-sm font-medium text-foreground truncate">{current.prompt}</p>
            </div>
            <div className="hidden lg:flex items-center gap-1.5 text-xs text-brand-text font-mono shrink-0">
              <span className="size-2 rounded-full bg-brand animate-ping motion-reduce:animate-none" />
              Agent Active
            </div>
          </div>

          {/* Main Content Grid: File Tree / Navigation + Code / Preview Area */}
          <div className="grid grid-cols-1 lg:grid-cols-12 min-h-[420px] bg-card">
            {/* Left Column: File Tree & Affected Files (3 cols) */}
            <div className="lg:col-span-4 border-b lg:border-b-0 lg:border-r border-border p-4 space-y-4 bg-muted/30">
              <div>
                <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-2 block">
                  Affected Repository Files
                </span>
                <div className="space-y-1.5">
                  {current.files.map((file) => (
                    <div
                      key={file.name}
                      className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-card border border-border text-xs font-mono shadow-2xs"
                    >
                      <div className="flex items-center gap-2 truncate">
                        <FileCode className="size-3.5 text-muted-foreground shrink-0" />
                        <span className="truncate text-foreground">{file.name}</span>
                      </div>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded-sm uppercase font-semibold shrink-0 ${
                          file.status === "created"
                            ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                            : file.status === "modified"
                            ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {file.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* View Switcher Tabs */}
              <div className="pt-2">
                <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-2 block">
                  Studio Inspector
                </span>
                <div className="grid grid-cols-3 gap-1 p-1 bg-muted rounded-xl border border-border">
                  <button
                    type="button"
                    aria-pressed={activeTab === "code"}
                    onClick={() => setActiveTab("code")}
                    className={`py-1.5 text-xs font-medium rounded-lg transition-colors ${
                      activeTab === "code"
                        ? "bg-card text-foreground shadow-xs font-semibold"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Code & Diff
                  </button>
                  <button
                    type="button"
                    aria-pressed={activeTab === "preview"}
                    onClick={() => setActiveTab("preview")}
                    className={`py-1.5 text-xs font-medium rounded-lg transition-colors ${
                      activeTab === "preview"
                        ? "bg-card text-foreground shadow-xs font-semibold"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Live Preview
                  </button>
                  <button
                    type="button"
                    aria-pressed={activeTab === "terminal"}
                    onClick={() => setActiveTab("terminal")}
                    className={`py-1.5 text-xs font-medium rounded-lg transition-colors ${
                      activeTab === "terminal"
                        ? "bg-card text-foreground shadow-xs font-semibold"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Terminal
                  </button>
                </div>
              </div>

              {/* Feature Insight Box */}
              <div className="p-3.5 rounded-xl bg-card border border-border text-xs text-muted-foreground space-y-1.5 shadow-2xs">
                <div className="font-semibold text-foreground flex items-center gap-1.5">
                  <Layers className="size-3.5 text-brand" />
                  <span>How it works:</span>
                </div>
                <p className="leading-relaxed">{current.description}</p>
              </div>
            </div>

            {/* Right Column: Code, Interactive Preview, or Terminal (8 cols) */}
            <div className="lg:col-span-8 flex flex-col bg-card">
              <AnimatePresence mode="wait">
                {activeTab === "code" && (
                  <motion.div
                    key="code"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="flex-1 flex flex-col font-mono text-xs overflow-x-auto bg-card"
                  >
                    <div className="flex-1 p-4 overflow-y-auto max-h-[380px] leading-relaxed">
                      <pre className="text-foreground/90 whitespace-pre">
                        <code>{current.code}</code>
                      </pre>
                    </div>
                  </motion.div>
                )}

                {activeTab === "preview" && (
                  <motion.div
                    key="preview"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="flex-1 p-6 flex flex-col justify-center items-center text-center bg-muted/20"
                  >
                    <div className="w-full max-w-md p-6 rounded-2xl border border-border/80 bg-card shadow-lg space-y-4 text-left">
                      <div className="flex items-center justify-between border-b border-border/50 pb-3">
                        <div className="flex items-center gap-2">
                          <span className="size-2 rounded-full bg-emerald-500 animate-pulse motion-reduce:animate-none" />
                          <span className="text-xs font-mono font-medium text-foreground">Sandbox Live Preview</span>
                        </div>
                        <span className="text-[11px] font-mono text-muted-foreground">localhost:5173</span>
                      </div>

                      <div className="space-y-3">
                        <h4 className="text-base font-semibold text-foreground">Sprint Velocity & Task Board</h4>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          Interactive in-browser app preview. Click the live interactive trigger below to test reactive state updates in the sandbox:
                        </p>

                        <div className="flex items-center gap-3 pt-1">
                          <button
                            onClick={() => setDemoClicks((c) => c + 1)}
                            className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg bg-brand text-brand-foreground font-semibold text-xs shadow-xs hover:bg-brand/90 transition-all cursor-pointer"
                          >
                            <Play className="size-3 fill-current" />
                            <span>Simulate Task Move ({demoClicks})</span>
                          </button>
                          <button
                            onClick={() => setDemoClicks(0)}
                            className="p-1.5 rounded-lg border border-border/60 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                            title="Reset counter"
                          >
                            <RotateCcw className="size-3.5" />
                          </button>
                        </div>

                        <div className="grid grid-cols-2 gap-2 pt-2 text-xs font-mono">
                          <div className="p-2.5 rounded-lg bg-muted/40 border border-border/40">
                            <span className="text-[10px] text-muted-foreground block uppercase">Completed</span>
                            <span className="text-base font-bold text-foreground">{demoClicks + 8} tasks</span>
                          </div>
                          <div className="p-2.5 rounded-lg bg-muted/40 border border-border/40">
                            <span className="text-[10px] text-muted-foreground block uppercase">Sprint State</span>
                            <span className="text-base font-bold text-emerald-500">In Progress</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                )}

                {activeTab === "terminal" && (
                  <motion.div
                    key="terminal"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="flex-1 p-4 font-mono text-xs overflow-y-auto max-h-[380px] bg-neutral-950 text-neutral-200"
                  >
                    <div className="space-y-1">
                      {current.terminalLog.map((line, idx) => (
                        <div
                          key={idx}
                          className={
                            line.startsWith("$")
                              ? "text-emerald-400 font-bold"
                              : line.startsWith("[agent]")
                              ? "text-brand"
                              : line.startsWith("[firecrawl]")
                              ? "text-amber-400"
                              : "text-neutral-300"
                          }
                        >
                          {line}
                        </div>
                      ))}
                      <div className="flex items-center gap-1.5 pt-2 text-neutral-500">
                        <span className="size-1.5 rounded-full bg-emerald-400 animate-ping motion-reduce:animate-none" />
                        <span>Ready for next prompt</span>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Bottom Quick-Action Bar */}
              <div className="p-3.5 border-t border-border bg-muted flex flex-wrap items-center justify-between gap-3 text-xs">
                <span className="text-muted-foreground font-medium">
                  Ready to test with your own repository or prompt?
                </span>
                <Link
                  href={SIGN_UP_URL}
                  className="inline-flex items-center gap-1.5 font-semibold text-foreground hover:text-brand transition-colors"
                >
                  <span>Launch in your browser</span>
                  <ArrowRight className="size-3.5" />
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
