"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from "motion/react";

import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/format-duration";
import { useNow } from "@/hooks/use-now";
import { BOOT_PHASES, type BootHistory, type BootPhase } from "@/features/sandbox-preview/utils/boot-phase";

const STEPS: { phase: BootPhase; label: string }[] = [
  { phase: "create", label: "Create sandbox" },
  { phase: "files", label: "Write files" },
  { phase: "install", label: "Install dependencies" },
  { phase: "start", label: "Start dev server" },
];

const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#$%&*<>/=+";
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
const EASE_OUT = [0.23, 1, 0.32, 1] as const;
const STREAM_LINES = 5;

export type BootStepsVariant = "morph" | "stream" | "interactive";

const randomGlyph = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)];

const logLines = (log: string) =>
  log
    .replace(ANSI_ESCAPE, "")
    .split(/\r?\n|\r/)
    .filter((line) => line.trim());

/**
 * Morphs `from` into `text` on mount: every character cycles through glyphs
 * and settles, left to right, out of a blur.
 */
const MorphText = ({ text, from }: { text: string; from: string }) => {
  const [chars, setChars] = useState(() => [...from].map((char) => ({ char, settled: false })));

  useEffect(() => {
    const still = from === text || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const length = Math.max(from.length, text.length);
    const frames = still ? 1 : 22;
    let frame = 0;
    const timer = setInterval(() => {
      frame += 1;
      // Characters settle left to right, each after a short spin.
      const settledUpTo = still ? length : ((frame - 4) / (frames - 4)) * length;
      const next = Array.from({ length }, (_, index) => {
        const target = text[index] ?? "";
        if (index < settledUpTo) return { char: target, settled: true };
        if (target === " ") return { char: " ", settled: true };
        return { char: randomGlyph(), settled: false };
      }).filter((entry, index) => index < text.length || !entry.settled);
      setChars(next);
      if (frame >= frames) clearInterval(timer);
    }, 34);
    return () => clearInterval(timer);
  }, [text, from]);

  return (
    <>
      <span aria-hidden="true" className="whitespace-pre-wrap break-words">
        {chars.map(({ char, settled }, index) => (
          <span
            key={index}
            className={cn(
              "inline-block transition-[filter,opacity,color] duration-300",
              !settled && "text-brand opacity-70 blur-[1.5px]",
            )}
          >
            {char}
          </span>
        ))}
      </span>
      <span className="sr-only">{text}</span>
    </>
  );
};

/** Types `text` out once, a few characters per frame. */
const TypedLine = ({ text }: { text: string }) => {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const perFrame = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? text.length : 3;
    const timer = setInterval(() => {
      setCount((value) => {
        if (value >= text.length) clearInterval(timer);
        return Math.min(text.length, value + perFrame);
      });
    }, 16);
    return () => clearInterval(timer);
  }, [text]);

  return (
    <>
      {text.slice(0, count)}
      <span className="ml-0.5 inline-block h-[1em] w-[0.5em] translate-y-[0.15em] animate-pulse bg-brand motion-reduce:animate-none" />
    </>
  );
};

/**
 * The preview's boot as type on the pane (#254). The step in progress is set
 * large and morphs into the next one; a finished step collapses into the
 * history above it. Elapsed time counts from mount, which is when the boot
 * starts showing.
 */
export const PreviewBootSteps = ({
  phase,
  history,
  log,
  firstStepLabel,
  onShowLogs,
  variant = "stream",
}: {
  /** The phase in progress; `null` before the first one is reported. */
  phase: BootPhase | null;
  history?: BootHistory;
  /** The boot's terminal output. */
  log: string;
  /** WebContainer boots in the page, so its first step isn't a sandbox. */
  firstStepLabel?: string;
  /** Reveals the terminal; omitted while it is already showing. */
  onShowLogs?: () => void;
  variant?: BootStepsVariant;
}) => {
  const [startedAt] = useState(() => Date.now());
  const now = useNow(true);
  const reduceMotion = useReducedMotion();
  const key = phase ?? "create";
  const current = Math.min(BOOT_PHASES.indexOf(key), STEPS.length - 1);
  // When each phase was first seen and how much log there was by then, for
  // the per-step times and log excerpts.
  const [observedMarks, setMarks] = useState<Partial<Record<BootPhase, { at: number; logAt: number }>>>({});
  if (!history && observedMarks[key] === undefined)
    setMarks({ ...observedMarks, [key]: { at: now, logAt: log.length } });
  const marks = history ?? observedMarks;
  const [expanded, setExpanded] = useState<BootPhase | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const progress = Math.min(1, (current + 0.5) / STEPS.length);
  const labelOf = (index: number) =>
    index === 0 && firstStepLabel ? firstStepLabel : STEPS[index].label;
  const lines = logLines(log);
  const done = STEPS.slice(0, current);
  const upcoming = STEPS.slice(current + 1);
  const active = STEPS[current];
  const activeStart = marks[active.phase]?.at;

  const stepTime = (index: number) => {
    const start = marks[STEPS[index].phase]?.at;
    const end = marks[BOOT_PHASES[index + 1]]?.at;
    return start !== undefined && end !== undefined ? formatDuration(end - start) : null;
  };
  const stepLog = (index: number) => {
    const start = marks[STEPS[index].phase]?.logAt ?? 0;
    const end = marks[BOOT_PHASES[index + 1]]?.logAt ?? log.length;
    return logLines(log.slice(start, end)).slice(-6);
  };

  // The spotlight follows the pointer across the stage text.
  const trackPointer = (event: PointerEvent<HTMLDivElement>) => {
    const stage = stageRef.current;
    if (!stage || variant !== "interactive") return;
    const rect = stage.getBoundingClientRect();
    stage.style.setProperty("--spot-x", `${event.clientX - rect.left}px`);
    stage.style.setProperty("--spot-y", `${event.clientY - rect.top}px`);
  };

  return (
    <MotionConfig reducedMotion="user">
      <div
        role="status"
        aria-label="Starting preview"
        className="size-full overflow-y-auto bg-background"
        onPointerMove={trackPointer}
      >
        <div className="mx-auto flex min-h-full w-full max-w-lg flex-col justify-center gap-6 px-6 py-8 @3xl:gap-8">
          <div className="space-y-3">
            <div className="flex items-center justify-between font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              <span className="flex items-center gap-2">
                <span aria-hidden="true" className="relative flex size-1.5">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand opacity-70 motion-reduce:animate-none" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-brand" />
                </span>
                Starting preview
              </span>
              <span className="tabular-nums">{formatDuration(now - (marks.create?.at ?? startedAt))}</span>
            </div>
            <div aria-hidden="true" className="relative h-px w-full overflow-hidden bg-border">
              <motion.div
                className="absolute inset-y-0 left-0 bg-foreground"
                initial={false}
                animate={{ width: `${progress * 100}%` }}
                transition={{ type: "spring", stiffness: 70, damping: 20 }}
              />
              <motion.div
                className="absolute inset-y-0 w-24 bg-gradient-to-r from-transparent via-brand to-transparent"
                animate={reduceMotion ? { left: "0%" } : { left: ["-6rem", `${progress * 100}%`] }}
                transition={{ duration: 1.6, repeat: reduceMotion ? 0 : Infinity, ease: "easeInOut" }}
              />
            </div>
          </div>

          <ol className="flex flex-col">
            {/* Finished steps: each collapses in from the stage. */}
            <AnimatePresence initial={false}>
              {done.map((step, index) => {
                const excerpt = variant === "interactive" ? stepLog(index) : [];
                const open = expanded === step.phase;
                return (
                  <motion.li
                    key={step.phase}
                    layout
                    initial={{ opacity: 0, scale: 1.9, y: 36, filter: "blur(6px)" }}
                    animate={{ opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }}
                    transition={{ duration: 0.6, ease: EASE_OUT }}
                    style={{ originX: 0 }}
                    data-state="done"
                    className="text-sm text-muted-foreground"
                  >
                    <button
                      type="button"
                      disabled={variant !== "interactive"}
                      onClick={() => setExpanded(open ? null : step.phase)}
                      aria-expanded={variant === "interactive" ? open : undefined}
                      className="group flex h-7 w-full items-baseline justify-between gap-4 text-left enabled:cursor-pointer"
                    >
                      <span className="flex min-w-0 items-baseline gap-3 transition-colors group-enabled:group-hover:text-foreground">
                        <span aria-hidden="true" className="w-4 shrink-0 font-mono text-xs text-brand">
                          ✓
                        </span>
                        <span className="truncate">
                          {labelOf(index)}
                          <span className="sr-only"> (done)</span>
                        </span>
                      </span>
                      <span className="shrink-0 font-mono text-xs tabular-nums">
                        {variant === "interactive" && (
                          <span className="mr-2 opacity-0 transition-opacity group-hover:opacity-100">
                            {open ? "hide" : "logs"}
                          </span>
                        )}
                        {stepTime(index)}
                      </span>
                    </button>
                    <AnimatePresence initial={false}>
                      {open && (
                        <motion.pre
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.3, ease: EASE_OUT }}
                          className="ml-7 overflow-hidden border-l border-border pl-3 font-mono text-[11px] leading-5 text-muted-foreground"
                        >
                          {excerpt.length > 0 ? excerpt.join("\n") : "No output"}
                        </motion.pre>
                      )}
                    </AnimatePresence>
                  </motion.li>
                );
              })}
            </AnimatePresence>

            {/* The stage: the step in progress, large, morphing into the next. */}
            <motion.li
              layout
              data-state="active"
              aria-current="step"
              className="py-3"
              transition={{ duration: 0.5, ease: EASE_OUT }}
            >
              <motion.div
                key={active.phase}
                ref={stageRef}
                initial={{ scale: 0.94, opacity: 0.6 }}
                animate={{ scale: reduceMotion ? 1 : [0.94, 1.03, 1], opacity: 1 }}
                transition={{ duration: 0.7, ease: EASE_OUT }}
                style={{ originX: 0 }}
                className={cn(
                  "text-3xl font-semibold tracking-tight text-foreground @3xl:text-5xl",
                  variant === "interactive" &&
                    "bg-[radial-gradient(160px_circle_at_var(--spot-x,30%)_var(--spot-y,50%),var(--brand),var(--foreground)_70%)] bg-clip-text text-transparent",
                )}
              >
                <MorphText text={labelOf(current)} from={current > 0 ? labelOf(current - 1) : ""} />
                <span className="sr-only"> (in progress)</span>
              </motion.div>
              <div className="mt-2 flex items-center gap-3 font-mono text-xs text-muted-foreground">
                <span>
                  Step {current + 1} of {STEPS.length}
                </span>
                <span aria-hidden="true" className="h-px w-6 bg-border" />
                <span className="tabular-nums">
                  {activeStart !== undefined ? formatDuration(now - activeStart) : null}
                </span>
              </div>
            </motion.li>

            {upcoming.map((step) => (
              <motion.li
                key={step.phase}
                layout
                transition={{ duration: 0.5, ease: EASE_OUT }}
                data-state="pending"
                className="flex h-7 items-baseline gap-3 text-sm text-muted-foreground/40"
              >
                <span aria-hidden="true" className="w-4 shrink-0 font-mono text-xs">
                  ·
                </span>
                {labelOf(STEPS.indexOf(step))}
              </motion.li>
            ))}
          </ol>

          {variant === "stream" ? (
            <div
              aria-hidden="true"
              className="space-y-1 font-mono text-xs text-muted-foreground [mask-image:linear-gradient(to_bottom,transparent,#000_45%)]"
            >
              <AnimatePresence initial={false} mode="popLayout">
                {lines.slice(-STREAM_LINES).map((line, index, shown) => (
                  <motion.p
                    key={`${lines.length - shown.length + index}`}
                    layout
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.25, ease: EASE_OUT }}
                    className="truncate"
                  >
                    <span className="text-brand">❯</span>{" "}
                    {index === shown.length - 1 ? <TypedLine text={line} /> : line}
                  </motion.p>
                ))}
              </AnimatePresence>
            </div>
          ) : (
            <div aria-hidden="true" className="relative min-h-5 overflow-hidden font-mono text-xs text-muted-foreground">
              <AnimatePresence mode="popLayout" initial={false}>
                {lines.length > 0 && (
                  <motion.p
                    key={lines.length}
                    initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
                    animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                    exit={{ opacity: 0, y: -8, filter: "blur(4px)" }}
                    transition={{ duration: 0.3, ease: EASE_OUT }}
                    className="truncate"
                  >
                    <span className="text-brand">❯</span> {lines.at(-1)}
                  </motion.p>
                )}
              </AnimatePresence>
            </div>
          )}

          {onShowLogs && (
            <button
              type="button"
              onClick={onShowLogs}
              className="self-start font-mono text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
            >
              Show logs
            </button>
          )}
        </div>
      </div>
    </MotionConfig>
  );
};
