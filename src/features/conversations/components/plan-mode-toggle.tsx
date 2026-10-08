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

/** Composer footer toggle: while on, messages ask for a plan, not a build (#120). */
export const PlanModeToggle = ({
  pressed,
  onPressedChange,
  disabled = false,
}: PlanModeToggleProps) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <PromptInputButton
        aria-pressed={pressed}
        variant={pressed ? "secondary" : "ghost"}
        onClick={() => onPressedChange(!pressed)}
        disabled={disabled}
        className={cn("h-8 shrink-0 rounded-lg px-2", pressed && "text-foreground")}
      >
        <ListChecksIcon className="size-4" />
        Plan
      </PromptInputButton>
    </TooltipTrigger>
    <TooltipContent>
      {pressed ? "Plan mode: the agent plans, nothing is built" : "Plan before building"}
    </TooltipContent>
  </Tooltip>
);
