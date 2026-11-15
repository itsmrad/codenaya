import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { HammerIcon, ListChecksIcon, UsersIcon } from "lucide-react";

import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { RadioGroup } from "@/components/ui/radio-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import type { MessageMode } from "../plan-mode";

export type ComposerMode = "build" | MessageMode;

const MODES = [
  { value: "build", label: "Build", icon: HammerIcon, hint: "Build with one agent" },
  { value: "plan", label: "Plan", icon: ListChecksIcon, hint: "Read-only: answers questions or plans, never changes files" },
  { value: "swarm", label: "Swarm", icon: UsersIcon, hint: "Build with a team of workers" },
] as const;

/** Mutually exclusive modes, as radios with arrow keys; build keeps the message's mode omitted. */
export const PlanModeToggle = ({
  mode,
  onModeChange,
  swarm = true,
  disabled = false,
}: {
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
  /** Off: the Swarm option is hidden (the SWARM_ENABLED kill switch). */
  swarm?: boolean;
  disabled?: boolean;
}) => (
  <RadioGroup
    aria-label="Message mode"
    value={mode}
    onValueChange={(value) => onModeChange(value as ComposerMode)}
    disabled={disabled}
    orientation="horizontal"
    className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border p-0.5"
  >
    {MODES.filter(({ value }) => swarm || value !== "swarm").map(({ value, label, icon: Icon, hint }) => (
      <Tooltip key={value}>
        <TooltipTrigger asChild>
          <RadioGroupPrimitive.Item value={value} aria-label={label} asChild>
            <PromptInputButton variant={mode === value ? "secondary" : "ghost"} className="h-7 rounded-md px-1.5">
              <Icon className="size-3.5" />
              <span className="hidden @[560px]:inline">{label}</span>
            </PromptInputButton>
          </RadioGroupPrimitive.Item>
        </TooltipTrigger>
        <TooltipContent>{hint}</TooltipContent>
      </Tooltip>
    ))}
  </RadioGroup>
);
