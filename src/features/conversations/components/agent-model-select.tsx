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

import { AGENT_MODELS, type AgentModelChoice } from "../agent-models";

/** Item with a muted tag on the right (the model's vendor or key). Drawn as
 *  `::after` so the trigger, which mirrors the item text, shows the name only. */
const TAGGED_ITEM =
  "after:ml-auto after:shrink-0 after:pl-4 after:text-[11px] after:text-muted-foreground after:content-[attr(data-tag)]";

const vendorOf = (modelId: string) =>
  AGENT_MODELS.find((model) => model.id === modelId)?.provider;

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
              data-tag={vendorOf(model.id)}
              className={TAGGED_ITEM}
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
                data-tag={key.label}
                className={TAGGED_ITEM}
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
