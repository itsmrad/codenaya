"use client";

import { formatDistanceToNow } from "date-fns";
import { Undo2Icon } from "lucide-react";
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

import { type Checkpoint, useRestoreCheckpoint } from "../hooks/use-checkpoints";

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
      () => toast.success("Files restored"),
      () => toast.error("Couldn't restore the files"),
    );
  };

  return (
    <AlertDialog open={checkpoint !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restore to before this run?</AlertDialogTitle>
          <AlertDialogDescription>
            The project&apos;s files go back to how they were{" "}
            {checkpoint &&
              formatDistanceToNow(checkpoint._creationTime, { addSuffix: true })}
            , before the agent ran. Changes made since then are replaced.
          </AlertDialogDescription>
        </AlertDialogHeader>
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
          run and everything after it.
        </DialogDescription>
      </DialogHeader>
      {checkpoints?.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No checkpoints yet.
        </p>
      ) : (
        <ul className="-mx-2 max-h-80 overflow-y-auto">
          {checkpoints?.map((checkpoint) => (
            <li
              key={checkpoint._id}
              className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-accent/40"
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
