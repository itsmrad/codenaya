import {
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
} from "@/components/ai-elements/prompt-input";
import { SelectGroup, SelectLabel } from "@/components/ui/select";

import {
  AGENT_MODELS,
  type AgentModelId,
  isAgentModelId,
} from "../agent-models";

// Grouped by provider, in allowlist order.
const MODEL_GROUPS = [...new Set(AGENT_MODELS.map((m) => m.provider))].map(
  (provider) => ({
    provider,
    models: AGENT_MODELS.filter((m) => m.provider === provider),
  }),
);

interface AgentModelSelectProps {
  value: AgentModelId;
  onValueChange: (model: AgentModelId) => void;
  disabled?: boolean;
}

export const AgentModelSelect = ({
  value,
  onValueChange,
  disabled,
}: AgentModelSelectProps) => (
  <PromptInputSelect
    value={value}
    onValueChange={(next) => {
      if (isAgentModelId(next)) onValueChange(next);
    }}
    disabled={disabled}
  >
    <PromptInputSelectTrigger
      size="sm"
      aria-label="Agent model"
      className="h-7 max-w-44 gap-1 rounded-md px-2 text-xs dark:bg-transparent dark:hover:bg-accent"
    >
      <PromptInputSelectValue />
    </PromptInputSelectTrigger>
    <PromptInputSelectContent position="popper" align="start">
      {MODEL_GROUPS.map(({ provider, models }) => (
        <SelectGroup key={provider}>
          <SelectLabel>{provider}</SelectLabel>
          {models.map((model) => (
            <PromptInputSelectItem key={model.id} value={model.id}>
              {model.label}
            </PromptInputSelectItem>
          ))}
        </SelectGroup>
      ))}
    </PromptInputSelectContent>
  </PromptInputSelect>
);
