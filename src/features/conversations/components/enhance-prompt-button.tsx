import { Loader2Icon, Undo2Icon, WandSparklesIcon } from "lucide-react";

import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import type { PromptEnhancer } from "../hooks/use-enhance-prompt";

interface EnhancePromptButtonProps {
  enhancer: PromptEnhancer;
  /** The composer's current text; the button is disabled while it is empty. */
  value: string;
  disabled?: boolean;
}

/**
 * Composer footer button: the wand rewrites the prompt into a clearer spec,
 * then turns into Undo, which restores what the user typed.
 */
export const EnhancePromptButton = ({
  enhancer,
  value,
  disabled = false,
}: EnhancePromptButtonProps) => {
  const { enhance, undo, isEnhancing, canUndo } = enhancer;

  if (canUndo) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <PromptInputButton
            aria-label="Undo enhance"
            onClick={undo}
            disabled={disabled}
            className="size-8 rounded-lg"
          >
            <Undo2Icon className="size-4" />
          </PromptInputButton>
        </TooltipTrigger>
        <TooltipContent>Undo enhance</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <PromptInputButton
          aria-label="Enhance prompt"
          aria-busy={isEnhancing}
          onClick={() => void enhance()}
          disabled={disabled || isEnhancing || !value.trim()}
          className="size-8 rounded-lg"
        >
          {isEnhancing ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <WandSparklesIcon className="size-4" />
          )}
        </PromptInputButton>
      </TooltipTrigger>
      <TooltipContent>Enhance prompt</TooltipContent>
    </Tooltip>
  );
};
