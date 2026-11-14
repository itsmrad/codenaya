import { HammerIcon, ListChecksIcon, UsersIcon } from "lucide-react";

import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import type { MessageMode } from "../plan-mode";

export type ComposerMode = "build" | MessageMode;

const MODES = [
  { value: "build", label: "Build", icon: HammerIcon, hint: "Build with one agent" },
  { value: "plan", label: "Plan", icon: ListChecksIcon, hint: "Plan before building" },
  { value: "swarm", label: "Swarm", icon: UsersIcon, hint: "Build with a team of workers" },
] as const;

/** Mutually exclusive modes; build keeps the message's mode omitted. */
export const PlanModeToggle = ({
  mode,
  onModeChange,
  disabled = false,
}: {
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
  disabled?: boolean;
}) => (
  <div role="group" aria-label="Message mode" className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border p-0.5">
    {MODES.map(({ value, label, icon: Icon, hint }) => (
      <Tooltip key={value}>
        <TooltipTrigger asChild>
          <PromptInputButton
            aria-label={label}
            aria-pressed={mode === value}
            variant={mode === value ? "secondary" : "ghost"}
            onClick={() => onModeChange(value)}
            disabled={disabled}
            className="h-7 rounded-md px-1.5"
          >
            <Icon className="size-3.5" />
            <span className="hidden @[560px]:inline">{label}</span>
          </PromptInputButton>
        </TooltipTrigger>
        <TooltipContent>{hint}</TooltipContent>
      </Tooltip>
    ))}
  </div>
);
