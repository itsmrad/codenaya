"use client";

import { FileCode2Icon, HammerIcon } from "lucide-react";

import { Shimmer } from "@/components/ai-elements/shimmer";
import { Skeleton } from "@/components/ui/skeleton";
import { liveStepLabel } from "@/features/conversations/components/agent-run";
import type { AgentStep } from "@/features/conversations/agent-steps";
import { getFilePath } from "@/features/sandbox-preview/utils/file-tree";

import { Doc } from "../../../../convex/_generated/dataModel";

/** Newest files shown before the rest collapse into "+N more". */
const FILE_LIMIT = 8;

/**
 * Shown in place of the preview while the agent writes a new project's first
 * build, so the sandbox doesn't boot against a half-written project.
 */
export const PreviewBuilding = ({
  steps,
  files,
}: {
  steps: AgentStep[];
  files: Doc<"files">[];
}) => {
  const filesMap = new Map(files.map((file) => [file._id, file]));
  const paths = files
    .filter((file) => file.type === "file")
    .sort((a, b) => b._creationTime - a._creationTime)
    .map((file) => getFilePath(file, filesMap));
  const more = paths.length - FILE_LIMIT;

  return (
    <div
      role="status"
      aria-label="Building your app"
      className="size-full overflow-y-auto bg-background p-4"
    >
      <div className="mx-auto flex min-h-full max-w-sm flex-col items-center justify-center gap-4 text-center">
        <div className="relative grid size-12 place-items-center rounded-2xl border border-border/60 bg-muted/40">
          <span className="absolute inset-0 animate-ping rounded-2xl bg-brand/10 motion-reduce:animate-none" />
          <HammerIcon className="size-5 text-brand" />
        </div>
        <div className="flex flex-col items-center gap-1">
          <p className="text-sm font-medium text-foreground">Building your app</p>
          <Shimmer as="span" className="max-w-full truncate text-xs">
            {liveStepLabel(steps)}
          </Shimmer>
        </div>

        <ul
          aria-label="Files written so far"
          className="w-full space-y-1 rounded-xl border border-border/50 bg-muted/20 p-2 text-left"
        >
          {paths.length === 0
            ? [0, 1, 2].map((index) => (
                <li key={index} className="flex h-6 items-center gap-2 px-1">
                  <Skeleton className="size-3.5 rounded-sm" />
                  <Skeleton className="h-3" style={{ width: `${70 - index * 15}%` }} />
                </li>
              ))
            : paths.slice(0, FILE_LIMIT).map((path) => (
                <li
                  key={path}
                  title={path}
                  className="flex h-6 min-w-0 items-center gap-2 px-1 font-mono text-[11px] text-foreground/80 animate-in fade-in-0 slide-in-from-top-1 duration-200 motion-reduce:animate-none"
                >
                  <FileCode2Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{path}</span>
                </li>
              ))}
          {more > 0 && (
            <li className="px-1 text-[11px] text-muted-foreground">+{more} more</li>
          )}
        </ul>

        <p className="text-xs text-muted-foreground">
          Preview starts when the first build finishes
        </p>
      </div>
    </div>
  );
};
