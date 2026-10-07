"use client";

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CopyIcon, PencilIcon, Trash2Icon } from "lucide-react";

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { Doc } from "../../../../convex/_generated/dataModel";
import { useDuplicateProject, useRemoveProject } from "../hooks/use-projects";

/**
 * A project's dropdown menu: any caller-specific `children` items, then
 * Rename, Duplicate and Delete. Rename and Delete are handed back to the
 * caller, which owns the inline input and the confirm dialog.
 */
export const ProjectActionsMenu = ({
  project,
  trigger,
  children,
  align = "end",
  onRename,
  onDelete,
}: {
  project: Doc<"projects">;
  trigger: React.ReactNode;
  children?: React.ReactNode;
  align?: "start" | "end";
  onRename: () => void;
  onDelete: () => void;
}) => {
  const router = useRouter();
  const duplicateProject = useDuplicateProject();
  // The menu returns focus to its trigger on close, which would blur (and so
  // submit) the rename input it just opened.
  const renaming = useRef(false);

  const handleDuplicate = async () => {
    const toastId = toast.loading("Duplicating…");
    try {
      const copyId = await duplicateProject({ id: project._id });
      toast.success("Project duplicated", {
        id: toastId,
        action: { label: "Open", onClick: () => router.push(`/projects/${copyId}`) },
      });
    } catch {
      toast.error("Couldn't duplicate the project", { id: toastId });
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        className="w-44"
        onCloseAutoFocus={(e) => {
          if (renaming.current) {
            e.preventDefault();
            renaming.current = false;
          }
        }}
      >
        {children}
        {children && <DropdownMenuSeparator />}
        <DropdownMenuItem
          onSelect={() => {
            renaming.current = true;
            onRename();
          }}
        >
          <PencilIcon />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleDuplicate}>
          <CopyIcon />
          Duplicate
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2Icon />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** Confirms and deletes a project. `onDeleting` runs once the delete is sent. */
export const DeleteProjectDialog = ({
  project,
  open,
  onOpenChange,
  onDeleting,
}: {
  project: Doc<"projects">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleting?: () => void;
}) => {
  const removeProject = useRemoveProject();

  const handleDelete = () => {
    const pending = removeProject({ id: project._id });
    onOpenChange(false);
    onDeleting?.();
    pending.then(
      () => toast.success(`Deleted “${project.name}”`),
      () => toast.error("Couldn't delete the project"),
    );
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{project.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Its files, chats, env vars and skills are deleted for good, and it is
            removed from the showcase. This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            onClick={handleDelete}
          >
            Delete project
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
