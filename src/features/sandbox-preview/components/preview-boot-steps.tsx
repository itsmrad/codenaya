"use client";

import { useId, useState } from "react";
import { CheckIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { formatDuration, useNow } from "@/features/conversations/components/agent-run";
import { BOOT_PHASES, type BootPhase } from "@/features/sandbox-preview/utils/boot-phase";

const STEPS: { phase: BootPhase; label: string }[] = [
  { phase: "create", label: "Create sandbox" },
  { phase: "files", label: "Write files" },
  { phase: "install", label: "Install dependencies" },
  { phase: "start", label: "Start dev server" },
];

/** Fixed spark lanes (left %, delay s, sway px) so renders stay pure. */
const SPARKS = [
  [6, 0, 14], [14, 3.1, -10], [23, 1.4, 8], [31, 5.2, -16], [40, 2.3, 12], [48, 6.1, -6],
  [57, 0.8, 16], [65, 4.4, -12], [73, 2.9, 10], [81, 5.8, -14], [89, 1.9, 6], [95, 3.7, -8],
] as const;

const RING_RADIUS = 54;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/**
 * The preview's boot as a stage: a progress core with the total time so far
 * over a drifting aurora and grid, and the four boot steps below it (#254).
 * Elapsed time counts from mount, which is when the boot starts showing.
 */
export const PreviewBootSteps = ({
  phase,
  firstStepLabel,
  onShowLogs,
}: {
  /** The phase in progress; `null` before the first one is reported. */
  phase: BootPhase | null;
  /** WebContainer boots in the page, so its first step isn't a sandbox. */
  firstStepLabel?: string;
  /** Reveals the terminal; omitted while it is already showing. */
  onShowLogs?: () => void;
}) => {
  const gradientId = useId();
  const [startedAt] = useState(() => Date.now());
  const now = useNow(true);
  const current = BOOT_PHASES.indexOf(phase ?? "create");
  // Half credit for the step in progress, so the ring moves as each starts.
  const progress = Math.min(1, (current + 0.5) / STEPS.length);

  return (
    <div
      role="status"
      aria-label="Starting preview"
      className="preview-boot relative size-full overflow-hidden bg-background"
    >
      <div aria-hidden="true" className="preview-boot-aurora absolute inset-0">
        <span />
        <span />
        <span />
      </div>
      <div aria-hidden="true" className="preview-boot-grid" />
      <div aria-hidden="true" className="preview-boot-sparks absolute inset-0">
        {SPARKS.map(([left, delay, sway]) => (
          <span
            key={left}
            style={{
              left: `${left}%`,
              animationDelay: `${delay}s`,
              ["--spark-sway" as string]: `${sway}px`,
            }}
          />
        ))}
      </div>

      <div className="relative z-10 size-full overflow-y-auto p-4">
        <div className="mx-auto flex min-h-full max-w-xs flex-col items-center justify-center gap-4 @md:gap-5">
          <div className="relative grid size-28 shrink-0 place-items-center @md:size-32 @3xl:size-40">
            <div aria-hidden="true" className="preview-boot-halo absolute -inset-2 rounded-full" />
            <svg
              aria-hidden="true"
              viewBox="0 0 120 120"
              className="absolute inset-0 size-full -rotate-90"
            >
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="var(--brand)" />
                  <stop offset="100%" stopColor="color-mix(in oklab, var(--brand) 30%, #a78bfa)" />
                </linearGradient>
              </defs>
              <circle
                cx="60"
                cy="60"
                r={RING_RADIUS}
                fill="none"
                strokeWidth="3"
                className="stroke-border/70"
              />
              <circle
                cx="60"
                cy="60"
                r={RING_RADIUS}
                fill="none"
                strokeWidth="3"
                strokeLinecap="round"
                stroke={`url(#${gradientId})`}
                strokeDasharray={RING_LENGTH}
                strokeDashoffset={RING_LENGTH * (1 - progress)}
                className="transition-[stroke-dashoffset] duration-700 ease-out"
              />
            </svg>
            <div aria-hidden="true" className="preview-boot-orbit absolute inset-0">
              <span className="absolute left-1/2 top-0 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand shadow-[0_0_12px_3px] shadow-brand/60" />
            </div>
            <div className="absolute inset-3 grid place-items-center rounded-full border border-border/40 bg-background/70 backdrop-blur-md">
              <div className="flex flex-col items-center gap-1">
                <span className="font-mono text-xl font-medium tabular-nums text-foreground @md:text-2xl @3xl:text-3xl">
                  {formatDuration(now - startedAt)}
                </span>
                <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
                  Step {Math.min(current + 1, STEPS.length)} of {STEPS.length}
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-col items-center gap-0.5 text-center">
            <p className="text-sm font-medium text-foreground">Starting preview</p>
            <p className="text-xs text-muted-foreground">Your app opens here when it&apos;s ready</p>
          </div>

          <ol className="w-full rounded-2xl border border-border/50 bg-card/50 p-2 shadow-lg shadow-black/5 backdrop-blur-xl dark:shadow-black/30">
            {STEPS.map((step, index) => {
              const state = index < current ? "done" : index === current ? "active" : "pending";
              const label = index === 0 && firstStepLabel ? firstStepLabel : step.label;
              return (
                <li
                  key={step.phase}
                  data-state={state}
                  aria-current={state === "active" ? "step" : undefined}
                  className={cn(
                    "relative flex h-9 items-center gap-3 rounded-xl px-2 text-xs transition-colors duration-300",
                    state === "active" && "bg-brand/[0.07]",
                  )}
                >
                  {/* The rail between steps, lit up to the step in progress. */}
                  {index < STEPS.length - 1 && (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "absolute left-[17px] top-[26px] h-[19px] w-px transition-colors duration-500",
                        index < current ? "bg-brand/60" : "bg-border",
                      )}
                    />
                  )}
                  <span
                    className={cn(
                      "relative grid size-5 shrink-0 place-items-center rounded-full border text-[10px] font-medium transition-all duration-300",
                      state === "done" &&
                        "border-brand/50 bg-brand text-brand-foreground shadow-[0_0_10px] shadow-brand/50",
                      state === "active" && "border-brand/70 text-brand",
                      state === "pending" && "border-border text-muted-foreground",
                    )}
                  >
                    {state === "done" ? (
                      <CheckIcon aria-hidden="true" className="size-3" strokeWidth={3} />
                    ) : (
                      index + 1
                    )}
                    {state === "active" && (
                      <span
                        aria-hidden="true"
                        className="absolute inset-0 animate-ping rounded-full border border-brand/60 motion-reduce:animate-none"
                      />
                    )}
                  </span>
                  {state === "active" ? (
                    <Shimmer as="span" className="font-medium">
                      {label}
                    </Shimmer>
                  ) : (
                    <span className={state === "pending" ? "text-muted-foreground" : "text-foreground/90"}>
                      {label}
                    </span>
                  )}
                  <span className="sr-only">
                    {state === "done" ? "(done)" : state === "active" ? "(in progress)" : ""}
                  </span>
                </li>
              );
            })}
          </ol>

          {onShowLogs && (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs text-muted-foreground"
              onClick={onShowLogs}
            >
              Show logs
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};
