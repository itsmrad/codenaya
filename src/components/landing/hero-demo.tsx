"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useInView } from "motion/react";
import { Check, FileCode2, ListChecks, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { useHydratedReducedMotion } from "./reveal";

const PROMPT = "Build a pomodoro timer with a task list";
const FILES = [
  "src/app/page.tsx",
  "src/components/timer.tsx",
  "src/components/task-list.tsx",
  "src/lib/use-countdown.ts",
];
const TASKS = ["Write the hero copy", "Review the PR", "Ship v1"];

// One run, in 50 ms ticks: type the prompt, write each file, show the preview, hold.
const TICK_MS = 50;
const TYPED_AT = PROMPT.length;
const FIRST_FILE_AT = TYPED_AT + 12;
const FILE_TICKS = 14;
const PREVIEW_AT = FIRST_FILE_AT + FILES.length * FILE_TICKS;
const LOOP_TICKS = PREVIEW_AT + 90;

/** Counts ticks through one run and starts over, while `running`. */
const useRunClock = (running: boolean) => {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick((t) => (t + 1) % LOOP_TICKS), TICK_MS);
    return () => clearInterval(id);
  }, [running]);
  return tick;
};

/**
 * A scripted IDE run under the hero: the prompt types itself, the agent writes
 * files, and the preview comes up. Reduced motion shows the finished run.
 */
export const HeroDemo = () => {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.3 });
  const reduceMotion = useHydratedReducedMotion();
  const clock = useRunClock(inView && !reduceMotion);
  const tick = reduceMotion ? PREVIEW_AT : clock;

  const typed = PROMPT.slice(0, tick);
  const filesWritten = Math.max(0, Math.min(FILES.length, Math.floor((tick - FIRST_FILE_AT) / FILE_TICKS)));
  const writing = tick >= FIRST_FILE_AT && tick < PREVIEW_AT ? filesWritten : -1;
  const previewReady = tick >= PREVIEW_AT;
  const secondsLeft = 25 * 60 - Math.max(0, Math.floor((tick - PREVIEW_AT) / 20));

  return (
    <div
      ref={ref}
      aria-hidden
      className="overflow-hidden rounded-lg border border-border bg-card shadow-[0_30px_80px_-40px_rgb(26_26_26/0.35)]"
    >
      {/* Window chrome */}
      <div className="flex h-10 items-center gap-3 border-b border-border px-4">
        <div className="flex gap-1.5">
          {[0, 1, 2].map((i) => (
            <span key={i} className="size-2.5 rounded-full border border-border bg-muted" />
          ))}
        </div>
        <div className="mx-auto rounded-md border border-border bg-background px-3 py-0.5 font-mono text-[11px] text-muted-foreground">
          codenaya.tech/projects/pomodoro
        </div>
        <span className="w-10" />
      </div>

      <div className="grid text-left md:grid-cols-[1.05fr_0.8fr_1.15fr]">
        {/* Chat */}
        <div className="flex min-h-72 flex-col gap-3 border-b border-border p-4 md:border-b-0 md:border-r">
          <Label>Agent</Label>
          <div className="self-end max-w-[90%] rounded-md bg-muted px-3 py-2 text-[13px] text-foreground">
            {typed}
            {tick < TYPED_AT && <span className="ml-0.5 inline-block h-3.5 w-px translate-y-0.5 animate-pulse bg-foreground" />}
          </div>
          {tick >= TYPED_AT && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col gap-2 text-[13px]"
            >
              <div className="flex items-center gap-2 text-muted-foreground">
                <ListChecks className="size-3.5" />
                Planning 4 files with Claude Sonnet 5.5
              </div>
              {FILES.slice(0, Math.min(FILES.length, filesWritten + 1)).map((file, i) =>
                tick < FIRST_FILE_AT ? null : (
                  <motion.div
                    key={file}
                    initial={{ opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="flex items-center gap-2 font-mono text-[12px] text-foreground"
                  >
                    {i < filesWritten ? (
                      <Check className="size-3.5 text-emerald-600" />
                    ) : (
                      <Loader2 className="size-3.5 animate-spin text-brand" />
                    )}
                    {i < filesWritten ? "Wrote" : "Writing"} {file.split("/").pop()}
                  </motion.div>
                ),
              )}
              {previewReady && (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-1 rounded-md border border-border px-3 py-2 text-muted-foreground"
                >
                  Done. Your timer is running in the preview.
                </motion.div>
              )}
            </motion.div>
          )}
        </div>

        {/* Files */}
        <div className="hidden flex-col gap-1 border-r border-border p-4 md:flex">
          <Label>Files</Label>
          {FILES.map((file, i) => (
            <div
              key={file}
              className={cn(
                "flex items-center gap-2 rounded px-2 py-1.5 font-mono text-[12px] transition-colors duration-300",
                i < filesWritten || previewReady ? "text-foreground" : "text-muted-foreground/40",
                writing === i && "bg-brand/10 text-brand-text",
              )}
            >
              <FileCode2 className="size-3.5 shrink-0" />
              <span className="truncate">{file.replace("src/", "")}</span>
            </div>
          ))}
        </div>

        {/* Preview */}
        <div className="flex min-h-72 flex-col gap-3 bg-background/60 p-4">
          <Label>Preview</Label>
          {previewReady ? (
            <motion.div
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
              className="flex flex-1 flex-col items-center justify-center gap-4 rounded-md border border-border bg-card p-4"
            >
              <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Focus</span>
              <span className="font-mono text-5xl font-semibold tabular-nums tracking-tight text-foreground">
                {String(Math.floor(secondsLeft / 60)).padStart(2, "0")}:{String(secondsLeft % 60).padStart(2, "0")}
              </span>
              <ul className="w-full max-w-52 space-y-1.5 text-[12px]">
                {TASKS.map((task, i) => (
                  <li key={task} className="flex items-center gap-2 text-muted-foreground">
                    <span className={cn("size-3 rounded-sm border border-border", i === 0 && "border-brand bg-brand")} />
                    <span className={cn(i === 0 && "line-through")}>{task}</span>
                  </li>
                ))}
              </ul>
            </motion.div>
          ) : (
            <div className="flex flex-1 flex-col gap-2 rounded-md border border-dashed border-border p-4">
              {[70, 45, 85, 60].map((w, i) => (
                <div key={i} className="h-2.5 animate-pulse rounded bg-muted" style={{ width: `${w}%` }} />
              ))}
              <span className="mt-auto font-mono text-[11px] text-muted-foreground">
                {tick < TYPED_AT ? "Waiting for a prompt" : "Building…"}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const Label = ({ children }: { children: string }) => (
  <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{children}</span>
);
