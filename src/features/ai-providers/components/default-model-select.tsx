"use client";

import { toast } from "sonner";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { AI_PROVIDERS, PLATFORM_PROVIDER, keyModels } from "../registry";
import { fromChoiceValue, toChoiceValue } from "../model-choice";
import { useSetAiPreferences } from "../hooks/use-ai-providers";
import type { AiProviderKeySummary } from "../../../../convex/aiProviders";
import { Id } from "../../../../convex/_generated/dataModel";

interface DefaultModelSelectProps {
  keys: AiProviderKeySummary[];
  defaultKeyId: Id<"aiProviderKeys"> | null;
  defaultModelId: string;
}

/**
 * Codenaya's models plus one group per active key. A default on a key that has
 * since been marked invalid stays listed so the current choice still shows.
 */
export const DefaultModelSelect = ({
  keys,
  defaultKeyId,
  defaultModelId,
}: DefaultModelSelectProps) => {
  const setPreferences = useSetAiPreferences();

  const groups = keys.filter(
    (key) => key.status === "active" || key._id === defaultKeyId,
  );
  const defaultKey = keys.find((key) => key._id === defaultKeyId);

  const handleChange = async (value: string) => {
    try {
      const { keyId, modelId } = fromChoiceValue(value);
      await setPreferences({
        defaultKeyId: keyId as Id<"aiProviderKeys"> | undefined,
        defaultModelId: modelId,
      });
      toast.success("Default model updated");
    } catch {
      toast.error("Could not update the default model");
    }
  };

  return (
    <div className="space-y-2">
      <Select
        value={toChoiceValue({
          keyId: defaultKeyId ?? undefined,
          modelId: defaultModelId,
        })}
        onValueChange={(value) => void handleChange(value)}
      >
        <SelectTrigger aria-label="Default model" className="w-full sm:w-80">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" className="max-h-80">
          <SelectGroup>
            <SelectLabel>{PLATFORM_PROVIDER.label}</SelectLabel>
            {PLATFORM_PROVIDER.models.map((model) => (
              <SelectItem key={model.id} value={toChoiceValue({ modelId: model.id })}>
                {model.label}
              </SelectItem>
            ))}
          </SelectGroup>
          {groups.map((key) => (
            <SelectGroup key={key._id}>
              <SelectLabel>
                {AI_PROVIDERS[key.provider].label} · {key.label}
                {key.status === "invalid" && " (invalid)"}
              </SelectLabel>
              {keyModels(key).map((model) => (
                <SelectItem key={model.id} value={toChoiceValue({ keyId: key._id, modelId: model.id })}>
                  {model.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      <p className="text-sm text-muted-foreground">
        {defaultKey
          ? `Agent runs use your key "${defaultKey.label}" and consume no Codenaya credits.`
          : "Agent runs use Codenaya's key and consume Codenaya credits."}
      </p>
    </div>
  );
};
