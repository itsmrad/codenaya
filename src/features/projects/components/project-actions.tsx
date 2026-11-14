"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CopyIcon, PencilIcon, Trash2Icon, XIcon } from "lucide-react";

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
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MENU_CONTENT, MENU_ITEM, MenuHeader } from "@/components/menu-chrome";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { cn } from "@/lib/utils";

import { Doc } from "../../../../convex/_generated/dataModel";
import { useDuplicateProject, useRemoveProject, useRenameProject } from "../hooks/use-projects";
import { PROJECT_NAME_MAX_LENGTH, validateProjectName } from "../utils/project-name";

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
        sideOffset={6}
        // The dashboard's menu look (menu-chrome); callers pass MENU_ITEM on `children`.
        className={cn(MENU_CONTENT, "w-56")}
        onCloseAutoFocus={(e) => {
          if (renaming.current) {
            e.preventDefault();
            renaming.current = false;
          }
        }}
      >
        <MenuHeader>Project</MenuHeader>
        <div className="p-1">
          {children}
          {children && <DropdownMenuSeparator />}
          <DropdownMenuItem
            onSelect={() => {
              renaming.current = true;
              onRename();
            }}
            className={MENU_ITEM}
          >
            <PencilIcon />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleDuplicate} className={MENU_ITEM}>
            <CopyIcon />
            Duplicate
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onDelete} className={cn(MENU_ITEM, "focus:bg-destructive/10")}>
            <Trash2Icon />
            Delete
          </DropdownMenuItem>
        </div>
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
    // The rename window's look: a `[ PROJECT ]` strip, a large title and a
    // tinted footer, with the destructive action in place of Save.
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="gap-0 overflow-hidden rounded-lg p-0 sm:max-w-md">
        <div className="flex h-10 items-center border-b border-border bg-muted/40 px-4 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          <span className="flex items-center gap-2.5">
            <span aria-hidden className="h-3 w-0.5 bg-destructive" />[ Project ]
          </span>
        </div>
        <AlertDialogHeader className="px-6 py-6 text-left sm:text-left">
          <AlertDialogTitle className="truncate text-2xl font-semibold tracking-[-0.03em]">
            Delete <span className="text-destructive">“{project.name}”</span>?
          </AlertDialogTitle>
          <AlertDialogDescription className="text-[15px]">
            Its files, chats, env vars and skills are deleted for good, and it is
            removed from the showcase. This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="items-center border-t border-border bg-muted/30 px-6 py-3.5 sm:justify-between">
          <span className="hidden font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground sm:block">
            Esc cancel
          </span>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <AlertDialogCancel className="rounded-md">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={cn(buttonVariants({ variant: "destructive" }), "rounded-md")}
              onClick={handleDelete}
            >
              Delete project
            </AlertDialogAction>
          </div>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

/**
 * Renames a project in a small window, like the import dialog: the name field
 * with a live count, its error inline, and Save. Mount it with a `key` per
 * opening so the field starts from the current name.
 */
export const RenameProjectDialog = ({
  project,
  open,
  onOpenChange,
}: {
  project: Doc<"projects">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const renameProject = useRenameProject();
  const [name, setName] = useState(project.name);
  const [touched, setTouched] = useState(false);
  const trimmed = name.trim();
  const error = validateProjectName(trimmed);
  const showError = touched && error !== null;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (error) return;
    onOpenChange(false);
    if (trimmed === project.name) return;
    renameProject({ id: project._id, name: trimmed }).then(
      () => toast.success("Project renamed"),
      () => toast.error("Couldn't rename the project"),
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="gap-0 overflow-hidden rounded-lg p-0 sm:max-w-md">
        <div className="flex h-10 items-center justify-between border-b border-border bg-muted/40 pl-4 pr-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          <span className="flex items-center gap-2.5">
            <span aria-hidden className="h-3 w-0.5 bg-brand" />[ Project ]
          </span>
          <DialogClose className="grid size-8 place-items-center rounded-md transition-colors hover:bg-muted hover:text-foreground">
            <XIcon className="size-4" />
            <span className="sr-only">Close</span>
          </DialogClose>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="px-6 pt-6 pb-6">
            <DialogHeader className="mb-6 text-left">
              <DialogTitle className="text-2xl font-semibold tracking-[-0.03em]">
                Rename <span className="text-brand">project</span>
              </DialogTitle>
              <DialogDescription className="truncate text-[15px]">
                Currently “{project.name}”.
              </DialogDescription>
            </DialogHeader>
            <div className="mb-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              <label htmlFor="rename-project">Project name</label>
              <span className={trimmed.length > PROJECT_NAME_MAX_LENGTH ? "text-destructive" : undefined}>
                {trimmed.length} / {PROJECT_NAME_MAX_LENGTH}
              </span>
            </div>
            <Input
              id="rename-project"
              value={name}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={showError}
              aria-describedby={showError ? "rename-project-error" : undefined}
              className="h-10 rounded-md text-[15px] focus-visible:border-brand/50 focus-visible:ring-4 focus-visible:ring-brand/10"
            />
            {showError && (
              <p id="rename-project-error" className="mt-2 text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter className="items-center border-t border-border bg-muted/30 px-6 py-3.5 sm:justify-between">
            <span className="hidden font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground sm:block">
              ↵ Save · Esc cancel
            </span>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="outline" className="rounded-md" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={showError}
                className="sheen rounded-md bg-brand text-brand-foreground shadow-[inset_0_-4px_8px_rgb(0_0_0/0.12),0_1px_2px_rgb(232_130_79/0.4)] hover:bg-brand/90"
              >
                Save
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
