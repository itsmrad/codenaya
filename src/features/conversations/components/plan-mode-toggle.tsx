import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { HammerIcon, ListChecksIcon, UsersIcon } from "lucide-react";

import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { RadioGroup } from "@/components/ui/radio-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import type { MessageMode } from "../plan-mode";

export type ComposerMode = "build" | MessageMode;

const MODES = [
  { value: "build", label: "Build", short: "Build", icon: HammerIcon, hint: "Build with one agent" },
  { value: "plan", label: "Ask / Plan", short: "Plan", icon: ListChecksIcon, hint: "Read-only: answers questions or plans, never changes files (Alt+M in chat composer)" },
  { value: "swarm", label: "Swarm", short: "Swarm", icon: UsersIcon, hint: "Build with a team of workers" },
] as const;

/** Mutually exclusive modes, as radios with arrow keys; build keeps the message's mode omitted. */
export const PlanModeToggle = ({
  mode,
  onModeChange,
  swarm = true,
  disabled = false,
  size = "default",
}: {
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
  /** Off: the Swarm option is hidden (the SWARM_ENABLED kill switch). */
  swarm?: boolean;
  disabled?: boolean;
  /** sm: full-height mono cells with short labels, for the project composer's toolbar. */
  size?: "default" | "sm";
}) => (
  <RadioGroup
    aria-label="Message mode"
    value={mode}
    onValueChange={(value) => onModeChange(value as ComposerMode)}
    disabled={disabled}
    orientation="horizontal"
    className={cn(
      "flex shrink-0",
      size === "sm" ? "h-full items-stretch" : "items-center gap-0.5 rounded-lg border border-border p-0.5",
    )}
  >
    {MODES.filter(({ value }) => swarm || value !== "swarm").map(({ value, label, short, icon: Icon, hint }) => (
      <Tooltip key={value}>
        <RadioGroupPrimitive.Item
          value={value}
          aria-label={label}
          // Radix defers arrow focus; keyup can clear its check-on-focus flag first.
          onFocus={() => { if (mode !== value) onModeChange(value); }}
          asChild
        >
          <TooltipTrigger asChild>
            {size === "sm" ? (
              <PromptInputButton
                variant={mode === value ? "secondary" : "ghost"}
                className="h-full gap-1.5 rounded-none font-mono text-[10px] uppercase tracking-[0.12em] focus-visible:ring-inset has-[>svg]:px-2.5"
              >
                <Icon className="size-3.5" />
                {/* Icon only until the composer (@container) has room beside the model name. */}
                <span className="hidden @[700px]:inline">{short}</span>
              </PromptInputButton>
            ) : (
              <PromptInputButton variant={mode === value ? "secondary" : "ghost"} className="h-7 rounded-md px-1.5">
                <Icon className="size-3.5" />
                <span className="hidden @[560px]:inline">{label}</span>
              </PromptInputButton>
            )}
          </TooltipTrigger>
        </RadioGroupPrimitive.Item>
        <TooltipContent>{hint}</TooltipContent>
      </Tooltip>
    ))}
  </RadioGroup>
);
