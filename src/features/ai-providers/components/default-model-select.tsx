"use client";

import { useState } from "react";
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

import { PLATFORM_PROVIDER, keyGroupLabel, keyModels, pickerKeys } from "../registry";
import { resolveCatalogModel } from "../platform";
import { fromChoiceValue, toChoiceValue } from "../model-choice";
import { usePlatformModelsOrCatalog, useSetAiPreferences } from "../hooks/use-ai-providers";
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
  const [saving, setSaving] = useState(false);

  const groups = pickerKeys(keys, defaultKeyId ?? undefined);
  const defaultKey = keys.find((key) => key._id === defaultKeyId);
  const platform = usePlatformModelsOrCatalog();
  // A platform default no longer offered shows as the one that runs.
  const modelId = defaultKeyId
    ? defaultModelId
    : resolveCatalogModel(platform, defaultModelId).id;

  const handleChange = async (value: string) => {
    setSaving(true);
    try {
      const { keyId, modelId } = fromChoiceValue(value);
      await setPreferences({
        defaultKeyId: keyId as Id<"aiProviderKeys"> | undefined,
        defaultModelId: modelId,
      });
      toast.success("Default model updated");
    } catch {
      toast.error(
        "Could not update the default model. Your previous choice still applies; try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <Select
        value={toChoiceValue({
          keyId: defaultKeyId ?? undefined,
          modelId,
        })}
        onValueChange={(value) => void handleChange(value)}
        disabled={saving}
      >
        <SelectTrigger aria-label="Default model" className="w-full sm:w-80">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" className="max-h-80">
          <SelectGroup>
            <SelectLabel>{PLATFORM_PROVIDER.label}</SelectLabel>
            {platform.models.map((model) => (
              <SelectItem key={model.id} value={toChoiceValue({ modelId: model.id })}>
                {model.name}
              </SelectItem>
            ))}
          </SelectGroup>
          {groups.map((key) => (
            <SelectGroup key={key._id}>
              <SelectLabel>{keyGroupLabel(key)}</SelectLabel>
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
