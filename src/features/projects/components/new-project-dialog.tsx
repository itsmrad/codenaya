"use client";

import { useState } from "react";
import ky from "ky";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";

import { Id } from "../../../../convex/_generated/dataModel";
import { detectCredential } from "@/features/integrations/credential-guard";

interface NewProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const NewProjectDialog = ({
  open,
  onOpenChange,
}: NewProjectDialogProps) => {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (message: PromptInputMessage) => {
    if (!message.text) return;

    if (detectCredential(message.text).detected) {
      toast.error(
        "Remove credentials from the prompt. Create the project first, then add the MCP connection through Integrations.",
      );
      return;
    }

    setIsSubmitting(true);

    try {
      const { projectId } = await ky
        .post("/api/projects/create-with-prompt", {
          json: { prompt: message.text.trim() },
        })
        .json<{ projectId: Id<"projects"> }>();

      toast.success("Project created");
      onOpenChange(false);
      setInput("");
      router.push(`/projects/${projectId}`);
    } catch {
      toast.error("Unable to create project");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent 
        showCloseButton={false}
        className="sm:max-w-lg p-0"
      >
        <DialogHeader className="gap-1 px-4 pt-4 text-left">
          <DialogTitle className="text-sm font-medium">
            What do you want to build?
          </DialogTitle>
          <DialogDescription className="text-xs">
            Describe your project and AI will help you create it.
          </DialogDescription>
        </DialogHeader>
        <div className="px-3 pb-3 pt-1">
          <PromptInput onSubmit={handleSubmit}>
            <PromptInputBody>
              <PromptInputTextarea
                placeholder="Ask Codenaya to build..."
                onChange={(e) => setInput(e.target.value)}
                value={input}
                disabled={isSubmitting}
              />
            </PromptInputBody>
            <PromptInputFooter>
               <PromptInputTools />
               <PromptInputSubmit disabled={!input || isSubmitting} />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </DialogContent>
    </Dialog>
  );
};
