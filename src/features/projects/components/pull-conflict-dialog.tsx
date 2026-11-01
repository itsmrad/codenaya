"use client";

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
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { GITHUB_SYNC_BRANCH } from "../constants";

/**
 * Shown when a pull finds changes on both GitHub and here (#343): take
 * GitHub's files (undoable from the checkpoint), or keep these and push them
 * to the sync branch.
 */
export const PullConflictDialog = ({
  branch,
  open,
  onOpenChange,
  onOverwrite,
  onKeepLocal,
}: {
  branch: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOverwrite: () => void;
  onKeepLocal: () => void;
}) => (
  <AlertDialog open={open} onOpenChange={onOpenChange}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Remote changed</AlertDialogTitle>
        <AlertDialogDescription>
          {branch} has new commits on GitHub, and this project has changes that
          aren&apos;t pushed yet. Overwriting keeps a checkpoint, so you can
          restore your files from the history.
        </AlertDialogDescription>
      </AlertDialogHeader>
      {/* Stacked at every width: the two long choices don't fit side by side. */}
      <AlertDialogFooter className="sm:flex-col-reverse">
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction
          // Outline has no text colour of its own to override the action's primary one.
          className={cn(buttonVariants({ variant: "outline" }), "text-foreground")}
          onClick={onKeepLocal}
        >
          Keep local and push to {GITHUB_SYNC_BRANCH}
        </AlertDialogAction>
        <AlertDialogAction onClick={onOverwrite}>
          Overwrite local with GitHub
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);
