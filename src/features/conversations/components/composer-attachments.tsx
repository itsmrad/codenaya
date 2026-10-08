import type { ReactNode } from "react";
import { ImageOffIcon, PlusIcon } from "lucide-react";

import {
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputButton,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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

/** Thumbnails of the attached images, plus a hint when the model can't read them. */
export const ComposerImages = ({ acceptsImages }: { acceptsImages: boolean }) => {
  const { files } = usePromptInputAttachments();
  if (files.length === 0) return null;

  return (
    <div className="w-full">
      <PromptInputAttachments className="p-2 pb-0">
        {(file) => <PromptInputAttachment data={file} />}
      </PromptInputAttachments>
      {!acceptsImages && (
        <p
          role="alert"
          className="flex items-center gap-1.5 px-3 pt-2 text-xs text-destructive"
        >
          <ImageOffIcon className="size-3.5 shrink-0" />
          This model can&apos;t read images. Pick a vision model to send them.
        </p>
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
