import { Loader2Icon, Undo2Icon, WandSparklesIcon } from "lucide-react";

import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { cn } from "@/lib/utils";

import type { PromptEnhancer } from "../hooks/use-enhance-prompt";

interface EnhancePromptButtonProps {
  enhancer: PromptEnhancer;
  /** The composer's current text; the button is disabled while it is empty. */
  value: string;
  disabled?: boolean;
  /** Replaces the default icon-button classes, e.g. to fill a toolbar cell. */
  className?: string;
  /** Show "Enhance" / "Undo" next to the icon. */
  showLabel?: boolean;
}

/**
 * Composer footer button: the wand rewrites the prompt into a clearer spec,
 * then turns into Undo, which restores what the user typed.
 */
export const EnhancePromptButton = ({
  enhancer,
  value,
  disabled = false,
  className,
  showLabel = false,
}: EnhancePromptButtonProps) => {
  const { enhance, undo, isEnhancing, canUndo } = enhancer;
  const classes = cn(showLabel ? "w-auto" : "size-8", "rounded-lg", className);
  const label = (text: string) => showLabel && <span className="max-sm:sr-only">{text}</span>;

  if (canUndo) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <PromptInputButton
            aria-label="Undo enhance"
            onClick={undo}
            disabled={disabled}
            className={classes}
          >
            <Undo2Icon className="size-4" />
            {label("Undo")}
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
          className={classes}
        >
          {isEnhancing ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <WandSparklesIcon className="size-4" />
          )}
          {label(isEnhancing ? "Enhancing" : "Enhance")}
        </PromptInputButton>
      </TooltipTrigger>
      <TooltipContent>Enhance prompt</TooltipContent>
    </Tooltip>
  );
};
