"use client";

import { useState } from "react";
import { FilePenIcon, FilePlus2Icon, FileX2Icon, Undo2Icon } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DiffViewer } from "@/features/editor/components/diff-viewer";
import { convexErrorMessage } from "@/lib/convex-error";
import { cn } from "@/lib/utils";

import type { Id } from "../../../../convex/_generated/dataModel";
import {
  type RunChange,
  useFileDiff,
  useRevertFile,
  useRunChanges,
} from "../hooks/use-checkpoints";

const STATUS = {
  added: { icon: FilePlus2Icon, label: "Added", className: "text-emerald-600 dark:text-emerald-400" },
  modified: { icon: FilePenIcon, label: "Modified", className: "text-amber-600 dark:text-amber-400" },
  deleted: { icon: FileX2Icon, label: "Deleted", className: "text-red-600 dark:text-red-400" },
} as const;

/** "+12 −3", or "binary" / "too large" when the file has no line counts. */
export const LineDelta = ({ change }: { change: Pick<RunChange, "binary" | "tooLarge" | "additions" | "deletions"> }) =>
  change.binary || change.tooLarge ? (
    <span className="text-muted-foreground">{change.binary ? "binary" : "too large"}</span>
  ) : (
    <span className="font-mono tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{change.additions}</span>{" "}
      <span className="text-red-600 dark:text-red-400">−{change.deletions}</span>
    </span>
  );

/** Sums a run's line counts for its summary line. */
export const totalDelta = (changes: RunChange[]) =>
  changes.reduce(
    (sum, change) => ({
      additions: sum.additions + (change.additions ?? 0),
      deletions: sum.deletions + (change.deletions ?? 0),
    }),
    { additions: 0, deletions: 0 },
  );

const DiffBody = ({ checkpointId, path, scope }: { checkpointId: Id<"checkpoints">; path: string; scope?: "project" }) => {
  const diff = useFileDiff(checkpointId, path, scope);
  const note = (text: string) => (
    <p className="p-6 text-center text-sm text-muted-foreground">{text}</p>
  );
  if (diff instanceof Error) return note("Couldn't load this diff.");
  if (diff === undefined) return note("Loading…");
  if (diff === null) return note("This file no longer differs from the checkpoint.");
  if (!("before" in diff)) {
    return note(diff.binary ? "Binary file changed. There is no text diff." : "This file is too large to diff.");
  }
  return <DiffViewer key={path} fileName={path} before={diff.before} after={diff.after} />;
};

/**
 * What one agent run changed, file by file, with a per-file revert (#225).
 * Full screen on phones, where the file list becomes a select.
 */
export const RunDiffDialog = ({
  checkpointId,
  open,
  onOpenChange,
  revertDisabled,
  scope,
  initialPath,
}: {
  checkpointId: Id<"checkpoints">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** An agent run is in progress. */
  revertDisabled: boolean;
  scope?: "project";
  initialPath?: string;
}) => {
  const result = useRunChanges(open ? checkpointId : null, scope);
  const changes = result instanceof Error ? null : result;
  const [selected, setSelected] = useState<string | undefined>(initialPath);
  const [confirming, setConfirming] = useState<RunChange | null>(null);
  const revert = useRevertFile();
  const [reverting, setReverting] = useState(false);
  const current = changes?.find((change) => change.path === selected) ?? changes?.[0];
  const total = changes && totalDelta(changes);

  const handleRevert = () => {
    if (!confirming) return;
    const path = confirming.path;
    setConfirming(null);
    setReverting(true);
    revert({ checkpointId, path, ...(scope && { scope }) }).then(
      () => toast.success(`Reverted ${path}`),
      (error) => toast.error(convexErrorMessage(error, "Couldn't revert the file")),
    ).finally(() => setReverting(false));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex flex-col gap-0 overflow-hidden p-0 max-sm:h-dvh max-sm:max-w-none max-sm:rounded-none max-sm:border-0 sm:h-[min(85vh,760px)] sm:max-w-5xl">
        <DialogHeader className="border-b px-4 py-3 pr-12 text-left">
          <DialogTitle className="text-base">{scope ? "Project changes" : "Changes in this run"}</DialogTitle>
          <DialogDescription>
            {changes === undefined
              ? "Loading…"
              : changes === null
                ? result instanceof Error ? "Couldn't load changes. Close and reopen to retry." : "Comparison exceeds the file or read limit; no partial results are shown."
                : `${changes.length} ${changes.length === 1 ? "file" : "files"} changed, +${total!.additions} −${total!.deletions} lines`}
          </DialogDescription>
        </DialogHeader>
        {changes?.length === 0 && (
          <p className="p-6 text-center text-sm text-muted-foreground">
            No changes from this checkpoint are left in the project.
          </p>
        )}
        {current && (
          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <div className="border-b p-2 sm:hidden">
              <Select value={current.path} onValueChange={setSelected}>
                <SelectTrigger aria-label="Changed file" className="w-full font-mono text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {changes!.map((change) => (
                    <SelectItem key={change.path} value={change.path} className="font-mono text-xs">
                      {change.path}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <ul aria-label="Changed files" className="hidden w-64 shrink-0 overflow-y-auto border-r p-1.5 sm:block">
              {changes!.map((change) => {
                const status = STATUS[change.status];
                return (
                  <li key={change.path}>
                    <button
                      type="button"
                      title={change.path}
                      aria-current={change.path === current.path ? "true" : undefined}
                      onClick={() => setSelected(change.path)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 aria-[current]:bg-accent"
                    >
                      <status.icon aria-label={status.label} className={cn("size-3.5 shrink-0", status.className)} />
                      <span className="min-w-0 flex-1 truncate font-mono">{change.path}</span>
                      <span className="shrink-0 text-[11px]">
                        <LineDelta change={change} />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="flex items-center gap-2 border-b px-3 py-2">
                <span className={cn("shrink-0 text-xs", STATUS[current.status].className)}>
                  {STATUS[current.status].label}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={current.path}>
                  {current.path}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={revertDisabled || reverting}
                  title={revertDisabled ? "Stop the running agent first" : undefined}
                  onClick={() => setConfirming(current)}
                >
                  <Undo2Icon className="size-3.5" />
                  {scope ? "Discard file changes" : "Revert this file"}
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                <DiffBody checkpointId={checkpointId} path={current.path} scope={scope} />
              </div>
            </div>
          </div>
        )}
      </DialogContent>
      <AlertDialog open={confirming !== null} onOpenChange={(open) => { if (!open) setConfirming(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{scope ? "Discard changes to" : "Revert"} {confirming?.path}?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.status === "added"
                ? "This file is absent from the checkpoint, so reverting deletes it."
                : "The file goes back to the checkpoint version, replacing any later edits to it."}{" "}
              Other files keep their changes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRevert}>Revert</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
};
