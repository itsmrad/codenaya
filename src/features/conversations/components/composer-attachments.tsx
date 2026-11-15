import type { ReactNode } from "react";
import { ImageOffIcon, PlusIcon } from "lucide-react";

import {
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputButton,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import type { AgentModelChoice } from "../agent-models";
import type { VisionSwitch } from "../vision-switch";

/**
 * Image attachments in the chat composer. Picking, pasting and dropping files,
 * and the type, size and count limits, are PromptInput's; these render inside
 * it and read its attachments.
 */

export const ComposerAttachButton = ({ disabled }: { disabled?: boolean }) => {
  const { openFileDialog } = usePromptInputAttachments();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <PromptInputButton
          disabled={disabled}
          aria-label="Attach images"
          className="size-8 rounded-lg"
          onClick={openFileDialog}
        >
          <PlusIcon className="size-4" />
        </PromptInputButton>
      </TooltipTrigger>
      <TooltipContent>Attach images</TooltipContent>
    </Tooltip>
  );
};

/**
 * Thumbnails of the attached images, plus a hint when the model can't read
 * them: a one-click switch to `visionSwitch` (#562), which only changes the
 * picked model and keeps the draft and images for the user to send.
 */
export const ComposerImages = ({
  acceptsImages,
  visionSwitch,
  onSwitchModel,
}: {
  acceptsImages: boolean;
  visionSwitch?: VisionSwitch;
  onSwitchModel: (choice: AgentModelChoice) => void;
}) => {
  const { files } = usePromptInputAttachments();
  if (files.length === 0) return null;

  return (
    <div className="w-full">
      <PromptInputAttachments className="p-2 pb-0" data-testid="composer-attachments">
        {(file) => <PromptInputAttachment data={file} />}
      </PromptInputAttachments>
      {!acceptsImages && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-3 pt-2 text-xs text-destructive"
        >
          <ImageOffIcon className="size-3.5 shrink-0" />
          {visionSwitch ? (
            <>
              This model can&apos;t read images.
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-6 px-2 text-xs"
                onClick={() => onSwitchModel(visionSwitch.choice)}
              >
                Switch to {visionSwitch.name}
              </Button>
              <span className="text-muted-foreground">{visionSwitch.billing}</span>
            </>
          ) : (
            "No model you can pick reads images. Remove the images to send."
          )}
        </div>
      )}
    </div>
  );
};

/** Hands the attachment count to a render prop, for controls outside the body. */
export const WithAttachmentCount = ({
  children,
}: {
  children: (count: number) => ReactNode;
}) => children(usePromptInputAttachments().files.length);
