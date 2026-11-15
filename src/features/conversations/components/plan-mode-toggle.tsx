import { ListChecksIcon } from "lucide-react";

import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface PlanModeToggleProps {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  disabled?: boolean;
}

/** Composer footer toggle: while on, messages get an answer or a plan, not a build (#120, #311). */
export const PlanModeToggle = ({
  pressed,
  onPressedChange,
  disabled = false,
}: PlanModeToggleProps) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <PromptInputButton
        aria-label="Ask / Plan"
        aria-pressed={pressed}
        variant={pressed ? "secondary" : "ghost"}
        onClick={() => onPressedChange(!pressed)}
        disabled={disabled}
        className={cn("h-8 shrink-0 rounded-lg px-2", pressed && "text-foreground")}
      >
        <ListChecksIcon className="size-4" />
        {/* Icon only in a narrow panel, so the model name keeps its room. */}
        <span className="hidden @[480px]:inline">Ask / Plan</span>
      </PromptInputButton>
    </TooltipTrigger>
    <TooltipContent>
      Read-only: answers questions or plans, never changes files
    </TooltipContent>
  </Tooltip>
);
