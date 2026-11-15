"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import type { ComposerMode } from "@/features/conversations/components/plan-mode-toggle";
import { useCreateProjectFromPrompt } from "../hooks/use-create-project-from-prompt";
import { PromptComposer } from "./prompt-composer";

interface NewProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const NewProjectDialog = ({
  open,
  onOpenChange,
}: NewProjectDialogProps) => {
  const { createProject, isSubmitting } = useCreateProjectFromPrompt();

  const handleSubmit = async (prompt: string, mode: ComposerMode) => {
    const created = await createProject(prompt, undefined, false, mode);
    if (created) onOpenChange(false);
    return created;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-xl p-0">
        <DialogHeader className="gap-1 px-4 pt-4 text-left">
          <DialogTitle className="text-sm font-medium">
            What do you want to build?
          </DialogTitle>
          <DialogDescription className="text-xs">
            Describe your project and AI will help you create it.
          </DialogDescription>
        </DialogHeader>
        <div className="px-3 pb-3 pt-1">
          <PromptComposer
            onSubmit={handleSubmit}
            isSubmitting={isSubmitting}
            autoFocus
          />
        </div>
      </DialogContent>
    </Dialog>
  );
};
