import {
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
} from "@/components/ai-elements/prompt-input";
import { SelectGroup, SelectLabel } from "@/components/ui/select";
import {
  AI_PROVIDERS,
  PLATFORM_PROVIDER,
  keyModels,
} from "@/features/ai-providers/registry";
import {
  fromChoiceValue,
  toChoiceValue,
} from "@/features/ai-providers/model-choice";
import { useAiProviderKeys } from "@/features/ai-providers/hooks/use-ai-providers";

import type { AgentModelChoice } from "../agent-models";

interface AgentModelSelectProps {
  value: AgentModelChoice;
  onValueChange: (model: AgentModelChoice) => void;
  disabled?: boolean;
}

/**
 * Codenaya's models plus one group per active key the user brought. A key
 * that has since been marked invalid stays listed while it is selected, so the
 * current choice still shows (and the run explains what is wrong).
 */
export const AgentModelSelect = ({
  value,
  onValueChange,
  disabled,
}: AgentModelSelectProps) => {
  const keys = useAiProviderKeys() ?? [];
  const keyGroups = keys.filter(
    (key) => key.status === "active" || key._id === value.keyId,
  );

  return (
    <PromptInputSelect
      value={toChoiceValue(value)}
      onValueChange={(next) => onValueChange(fromChoiceValue(next))}
      disabled={disabled}
    >
      <PromptInputSelectTrigger
        size="sm"
        aria-label="Agent model"
        className="h-7 min-w-0 max-w-44 gap-1 rounded-md px-2 text-xs dark:bg-transparent dark:hover:bg-accent"
      >
        <PromptInputSelectValue />
      </PromptInputSelectTrigger>
      <PromptInputSelectContent position="popper" align="start" className="max-h-80">
        <SelectGroup>
          <SelectLabel>{PLATFORM_PROVIDER.label}</SelectLabel>
          {PLATFORM_PROVIDER.models.map((model) => (
            <PromptInputSelectItem
              key={model.id}
              value={toChoiceValue({ modelId: model.id })}
            >
              {model.label}
            </PromptInputSelectItem>
          ))}
        </SelectGroup>
        {keyGroups.map((key) => (
          <SelectGroup key={key._id}>
            <SelectLabel>
              {AI_PROVIDERS[key.provider].label} · {key.label}
              {key.status === "invalid" && " (invalid)"}
            </SelectLabel>
            {keyModels(key).map((model) => (
              <PromptInputSelectItem
                key={model.id}
                value={toChoiceValue({ keyId: key._id, modelId: model.id })}
              >
                {model.label}
              </PromptInputSelectItem>
            ))}
          </SelectGroup>
        ))}
      </PromptInputSelectContent>
    </PromptInputSelect>
  );
};
