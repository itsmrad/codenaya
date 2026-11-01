"use client";

import {
  FileTextIcon,
  ListChecksIcon,
  RepeatIcon,
  RotateCcwIcon,
  Undo2Icon,
} from "lucide-react";

import { Button } from "@/components/ui/button";

import { STUCK_REASONS, type StuckRun } from "../agent-steps";

const usd = (value: number) => `$${value.toFixed(2)}`;

export interface StuckRetry {
  /** The model one tier up (`nextTier`). */
  label: string;
  costUsd: readonly [number, number];
  onRetry: () => void;
}

interface StuckRunCardProps {
  stuck: StuckRun;
  /** The file in the loop, when it still exists. */
  filePath?: string;
  /** Unset on a top-tier model: Diagnose becomes the main action. */
  retry?: StuckRetry;
  onDiagnose?: () => void;
  onRestore?: () => void;
  onOpenFile?: (path: string) => void;
}

/** Hand-off for a run stopped going in circles (#306): undo, step up, or diagnose. */
export const StuckRunCard = ({
  stuck,
  filePath,
  retry,
  onDiagnose,
  onRestore,
  onOpenFile,
}: StuckRunCardProps) => (
  <div
    role="group"
    aria-label="The agent got stuck"
    className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm"
  >
    <p className="flex items-center gap-1.5 font-medium">
      <RepeatIcon className="size-3.5 text-amber-600 dark:text-amber-400" aria-hidden />
      The agent got stuck
    </p>
    <p className="mt-0.5 text-muted-foreground">
      It stopped early because {STUCK_REASONS[stuck.reason]}.
    </p>
    {stuck.error && (
      <p className="mt-2 line-clamp-3 rounded-md bg-background/60 px-2 py-1.5 font-mono text-xs/5 [overflow-wrap:anywhere]">
        {stuck.error}
      </p>
    )}
    <div className="mt-3 flex flex-wrap gap-1.5">
      {retry && (
        // Wraps instead of overflowing a narrow chat panel.
        <Button
          type="button"
          size="sm"
          onClick={retry.onRetry}
          className="h-auto min-h-8 max-w-full whitespace-normal py-1.5 text-left"
        >
          <RotateCcwIcon className="size-3.5" />
          Retry on {retry.label}
          <span className="font-normal opacity-80">
            · ~{usd(retry.costUsd[0])}–{usd(retry.costUsd[1])}
          </span>
        </Button>
      )}
      {onDiagnose && (
        <Button
          type="button"
          size="sm"
          variant={retry ? "outline" : "default"}
          onClick={onDiagnose}
        >
          <ListChecksIcon className="size-3.5" />
          Diagnose in Plan mode
        </Button>
      )}
      {onRestore && (
        <Button type="button" size="sm" variant="outline" onClick={onRestore}>
          <Undo2Icon className="size-3.5" />
          Restore to before this run
        </Button>
      )}
      {filePath && onOpenFile && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          title={filePath}
          onClick={() => onOpenFile(filePath)}
        >
          <FileTextIcon className="size-3.5" />
          Open {filePath.split("/").pop()}
        </Button>
      )}
    </div>
  </div>
);
