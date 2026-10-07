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

import { AI_PROVIDERS, PLATFORM_PROVIDER } from "../registry";
import { useSetAiPreferences } from "../hooks/use-ai-providers";
import type { AiProviderKeySummary } from "../../../../convex/aiProviders";
import { Id } from "../../../../convex/_generated/dataModel";

/**
 * Select values pair a key with a model as `<keyId>:<modelId>`. Convex ids
 * never contain `:`, so the first one splits them; model ids may contain more.
 */
const PLATFORM_VALUE = "codenaya";

const toValue = (keyId: string | null, modelId: string) =>
  `${keyId ?? PLATFORM_VALUE}:${modelId}`;

const fromValue = (value: string) => {
  const separator = value.indexOf(":");
  const keyId = value.slice(0, separator);
  return {
    defaultKeyId:
      keyId === PLATFORM_VALUE ? undefined : (keyId as Id<"aiProviderKeys">),
    defaultModelId: value.slice(separator + 1),
  };
};

/** A key's models, labelled from the registry; custom ids label themselves. */
const keyModels = (key: AiProviderKeySummary) =>
  key.provider === "custom"
    ? (key.modelIds ?? []).map((id) => ({ id, label: id }))
    : AI_PROVIDERS[key.provider].models;

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
      await setPreferences(fromValue(value));
      toast.success("Default model updated");
    } catch {
      toast.error("Could not update the default model");
    }
  };

  return (
    <div className="space-y-2">
      <Select
        value={toValue(defaultKeyId, defaultModelId)}
        onValueChange={(value) => void handleChange(value)}
      >
        <SelectTrigger aria-label="Default model" className="w-full sm:w-80">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" className="max-h-80">
          <SelectGroup>
            <SelectLabel>{PLATFORM_PROVIDER.label}</SelectLabel>
            {PLATFORM_PROVIDER.models.map((model) => (
              <SelectItem key={model.id} value={toValue(null, model.id)}>
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
                <SelectItem key={model.id} value={toValue(key._id, model.id)}>
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
