"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { GitForkIcon, Undo2Icon } from "lucide-react";
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
import { confirmLeaveEditor } from "@/features/editor/hooks/use-editor-leave-guard";
import { convexErrorMessage } from "@/lib/convex-error";

import type { Id } from "../../../../convex/_generated/dataModel";

import { type Checkpoint, undoAction, useForkFromCheckpoint, useRestoreCheckpoint, useRunChanges } from "../hooks/use-checkpoints";
import { restorePlan } from "../restore-plan";

/** What a restore will do to the files, from the live-vs-checkpoint comparison (#363). */
const RestorePlan = ({ checkpointId }: { checkpointId: Id<"checkpoints"> }) => {
  const changes = useRunChanges(checkpointId, "project");
  if (changes === undefined) {
    return <p role="status" className="text-sm text-muted-foreground">Checking what will change…</p>;
  }
  // Null: too many files to compare; an Error: the query failed. Restore still works.
  if (changes === null || changes instanceof Error) return null;
  const { changed, removed, recreated } = restorePlan(changes);
  if (changes.length === 0) {
    return <p className="text-sm text-muted-foreground">No files differ from this checkpoint.</p>;
  }
  const groups = [
    ["Changed back", changed],
    ["Removed (created since)", removed],
    ["Brought back (deleted since)", recreated],
  ] as const;
  return (
    <div className="max-h-48 space-y-2 overflow-y-auto text-sm">
      {groups.map(([title, paths]) =>
        paths.length === 0 ? null : (
          <div key={title}>
            <p className="font-medium">{title} ({paths.length})</p>
            <ul className="font-mono text-xs text-muted-foreground">
              {paths.map((path) => <li key={path} className="truncate" title={path}>{path}</li>)}
            </ul>
          </div>
        ),
      )}
    </div>
  );
};

/** Shared by history and the run action row; a fork is safe during an active run. */
export const ForkCheckpointButton = ({ checkpointId }: { checkpointId: Id<"checkpoints"> }) => {
  const fork = useForkFromCheckpoint();
  const router = useRouter();
  const pending = useRef(false);
  const [isPending, setIsPending] = useState(false);
  const handleFork = async () => {
    if (pending.current) return;
    pending.current = true;
    setIsPending(true);
    try {
      const projectId = await fork({ checkpointId });
      const open = () => {
        const href = `/projects/${projectId}`;
        if (confirmLeaveEditor(href)) router.push(href);
      };
      toast.success("Project forked", { action: { label: "Open fork", onClick: open } });
      open();
    } catch (error) {
      toast.error(convexErrorMessage(error, "Couldn't fork this checkpoint"));
    } finally {
      pending.current = false;
      setIsPending(false);
    }
  };
  return (
    <Button size="sm" variant="outline" disabled={isPending} onClick={handleFork}>
      <GitForkIcon className="size-3.5" />
      {isPending ? "Forking…" : "Fork from here"}
    </Button>
  );
};

/** Confirms, then puts the project's files back as they were before a run. */
export const RestoreCheckpointDialog = ({
  checkpoint,
  onOpenChange,
}: {
  checkpoint: Checkpoint | null;
  onOpenChange: (open: boolean) => void;
}) => {
  const restore = useRestoreCheckpoint();

  const handleRestore = () => {
    if (!checkpoint) return;
    onOpenChange(false);
    restore({ checkpointId: checkpoint._id }).then(
      (undoCheckpointId) =>
        toast.success("Files restored", {
          action: undoAction(() =>
            restore({ checkpointId: undoCheckpointId }).then(
              () => toast.success("Restore undone"),
              (error) => toast.error(convexErrorMessage(error, "Couldn't undo the restore")),
            ),
          ),
        }),
      () => toast.error("Couldn't restore the files"),
    );
  };

  return (
    <AlertDialog open={checkpoint !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{checkpoint?.messageId ? "Restore to before this run?" : "Restore this checkpoint?"}</AlertDialogTitle>
          <AlertDialogDescription>
            The project&apos;s files go back to how they were{" "}
            {checkpoint &&
              formatDistanceToNow(checkpoint._creationTime, { addSuffix: true })}
            . Changes made since then are replaced, including manual edits.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {checkpoint && <RestorePlan checkpointId={checkpoint._id} />}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleRestore}>Restore</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

/** The project's checkpoints, newest first, each restorable. */
export const CheckpointHistoryDialog = ({
  checkpoints,
  open,
  onOpenChange,
  onRestore,
  disabled,
}: {
  checkpoints: Checkpoint[] | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestore: (checkpoint: Checkpoint) => void;
  /** An agent run is in progress. */
  disabled: boolean;
}) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Version history</DialogTitle>
        <DialogDescription>
          A checkpoint is saved before each agent run. Restore one to undo the
          run and everything after it, or fork one into a new project.
        </DialogDescription>
      </DialogHeader>
      {checkpoints === undefined ? (
        <p role="status" className="py-6 text-center text-sm text-muted-foreground">
          Loading version history…
        </p>
      ) : checkpoints.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No checkpoints yet.
        </p>
      ) : (
        <ul className="-mx-2 max-h-80 overflow-y-auto">
          {checkpoints?.map((checkpoint) => (
            <li
              key={checkpoint._id}
              className="flex flex-wrap items-center gap-2 rounded-md px-2 py-2 hover:bg-accent/40"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm" title={checkpoint.label}>
                  {checkpoint.label || "Agent run"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatDistanceToNow(checkpoint._creationTime, { addSuffix: true })}
                  {" · "}
                  {checkpoint.fileCount} {checkpoint.fileCount === 1 ? "file" : "files"}
                </p>
              </div>
              <ForkCheckpointButton checkpointId={checkpoint._id} />
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => onRestore(checkpoint)}
              >
                <Undo2Icon className="size-3.5" />
                Restore
              </Button>
            </li>
          ))}
        </ul>
      )}
    </DialogContent>
  </Dialog>
);
