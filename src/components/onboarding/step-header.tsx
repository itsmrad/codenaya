"use client";

import { cn } from "@/lib/utils";
import { STEP_TITLES, type StepKey } from "./types";

export function StepHeader({ flow, stepKey }: { flow: StepKey[]; stepKey: StepKey }) {
  const index = flow.indexOf(stepKey);

  return (
    <div className="mb-8 max-w-[544px]">
      <p className="mb-3 font-mono text-xs font-medium tracking-wide text-muted-foreground">
        STEP {index + 1} OF {flow.length} — {STEP_TITLES[stepKey].toUpperCase()}
      </p>
      <div className="flex gap-1.5">
        {flow.map((s, i) => (
          <div
            key={s}
            className={cn(
              "h-1 flex-1 rounded-full bg-muted-foreground/25",
              i <= index && "bg-brand"
            )}
          />
        ))}
      </div>
    </div>
  );
}
