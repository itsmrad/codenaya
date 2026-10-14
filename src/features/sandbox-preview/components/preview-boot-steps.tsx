"use client";

import { useState } from "react";
import { CheckIcon, Loader2Icon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { formatDuration, useNow } from "@/features/conversations/components/agent-run";
import { BOOT_PHASES, type BootPhase } from "@/features/sandbox-preview/utils/boot-phase";

const STEPS: { phase: BootPhase; label: string }[] = [
  { phase: "create", label: "Create sandbox" },
  { phase: "files", label: "Write files" },
  { phase: "install", label: "Install dependencies" },
  { phase: "start", label: "Start dev server" },
];

/**
 * The preview's boot as a checklist with the total time so far, in place of a
 * bare spinner (#254). Elapsed time counts from mount, which is when the boot
 * starts showing.
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
  const [startedAt] = useState(() => Date.now());
  const now = useNow(true);
  const current = BOOT_PHASES.indexOf(phase ?? "create");

  return (
    <div
      role="status"
      aria-label="Starting preview"
      className="size-full overflow-y-auto bg-background p-4"
    >
      <div className="mx-auto flex min-h-full max-w-xs flex-col justify-center gap-4">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-medium text-foreground">Starting preview</p>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {formatDuration(now - startedAt)}
          </span>
        </div>

        <ol className="space-y-1 rounded-xl border border-border/50 bg-muted/20 p-2">
          {STEPS.map((step, index) => {
            const state = index < current ? "done" : index === current ? "active" : "pending";
            return (
              <li
                key={step.phase}
                data-state={state}
                aria-current={state === "active" ? "step" : undefined}
                className="flex h-8 items-center gap-2.5 px-1.5 text-xs"
              >
                <span
                  className={cn(
                    "grid size-4.5 shrink-0 place-items-center rounded-full border",
                    state === "done" && "border-brand/40 bg-brand/15 text-brand",
                    state === "active" && "border-transparent text-foreground",
                    state === "pending" && "border-border text-transparent",
                  )}
                >
                  {state === "done" && <CheckIcon aria-hidden="true" className="size-3" />}
                  {state === "active" && (
                    <Loader2Icon aria-hidden="true" className="size-3.5 animate-spin" />
                  )}
                </span>
                <span
                  className={cn(
                    state === "pending" ? "text-muted-foreground" : "text-foreground",
                    state === "active" && "font-medium",
                  )}
                >
                  {index === 0 && firstStepLabel ? firstStepLabel : step.label}
                </span>
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
            className="h-auto self-center p-0 text-xs text-muted-foreground"
            onClick={onShowLogs}
          >
            Show logs
          </Button>
        )}
      </div>
    </div>
  );
};
