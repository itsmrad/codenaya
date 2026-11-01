import {
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
} from "@/components/ai-elements/prompt-input";
import { SelectGroup, SelectLabel } from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AI_PROVIDERS,
  PLATFORM_PROVIDER,
  keyModels,
  runModelLabel,
} from "@/features/ai-providers/registry";
import { resolveCatalogModel } from "@/features/ai-providers/platform";
import {
  fromChoiceValue,
  toChoiceValue,
} from "@/features/ai-providers/model-choice";
import {
  useAiProviderKeys,
  usePlatformModelsOrCatalog,
} from "@/features/ai-providers/hooks/use-ai-providers";
import { estimateRunCredits, formatCredits } from "@/features/billing/plans";

import type { AgentModelChoice } from "../agent-models";

/** Item with a muted tag on the right (the model's vendor or key). Drawn as
 *  `::after` so the trigger, which mirrors the item text, shows the name only. */
const TAGGED_ITEM =
  "after:ml-auto after:shrink-0 after:pl-4 after:text-[11px] after:text-muted-foreground after:content-[attr(data-tag)]";

interface AgentModelSelectProps {
  value: AgentModelChoice;
  onValueChange: (model: AgentModelChoice) => void;
  disabled?: boolean;
}

/**
 * Codenaya's models, the promo models the user claimed (ADR 0009), and one
 * group per active key the user brought. A key that has since been marked
 * invalid stays listed while it is selected, so the current choice still
 * shows (and the run explains what is wrong).
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
  const selectedKey = keys.find((key) => key._id === value.keyId);
  const platform = usePlatformModelsOrCatalog();
  const everyoneModels = platform.models.filter((model) => model.access === "everyone");
  const promoModels = platform.models.filter((model) => model.access !== "everyone");
  const selectedPlatformModel = resolveCatalogModel(platform, value.modelId);
  const promoLimit = (access: (typeof platform.models)[number]["access"]) =>
    access === "promo_counted" ? `${platform.countedRunsLeft} runs left` : "Unlimited";
  const selectedPromo = !selectedKey && selectedPlatformModel.access !== "everyone";

  // Pre-run cost estimation tooltip logic (#105)
  const isByok = Boolean(value.keyId);
  const isPromo = selectedPromo;
  const { credits } = estimateRunCredits(value.modelId, "quick_edit", isByok || isPromo);
  const costTooltip = isByok
    ? "BYOK (Your API Key) • 0 platform credits"
    : isPromo
      ? "Free Promotion • 0 platform credits"
      : credits !== null
        ? `~${formatCredits(credits)} credits (~$${(credits / 100).toFixed(2)}) est. typical edit`
        : null;

  return (
    <PromptInputSelect
      value={toChoiceValue(value)}
      onValueChange={(next) => onValueChange(fromChoiceValue(next))}
      disabled={disabled}
    >
      {/* A narrow panel truncates the name; the tooltip keeps it readable (#217). */}
      <Tooltip>
        <TooltipTrigger asChild>
          <PromptInputSelectTrigger
            size="sm"
            aria-label="Agent model"
            className="h-7 min-w-0 max-w-64 gap-1 rounded-md px-2 text-xs dark:bg-transparent dark:hover:bg-accent"
          >
            <PromptInputSelectValue />
            {selectedPromo && (
              <span className="shrink-0 rounded bg-primary/10 px-1 text-[10px] font-medium text-primary">
                Promo · {promoLimit(selectedPlatformModel.access)}
              </span>
            )}
          </PromptInputSelectTrigger>
        </TooltipTrigger>
        <TooltipContent className="flex flex-col gap-0.5 text-xs">
          <span className="font-medium">
            {selectedKey
              ? runModelLabel(value.modelId, selectedKey)
              : runModelLabel({ id: selectedPlatformModel.id, label: selectedPlatformModel.name })}
          </span>
          {costTooltip && (
            <span className="text-[11px] text-background/80">{costTooltip}</span>
          )}
        </TooltipContent>
      </Tooltip>
      <PromptInputSelectContent position="popper" align="start" className="max-h-80">
        <SelectGroup>
          <SelectLabel>{PLATFORM_PROVIDER.label}</SelectLabel>
          {everyoneModels.map((model) => {
            const { credits: mCredits } = estimateRunCredits(model.id, "quick_edit", false);
            const tag = mCredits !== null ? `~${formatCredits(mCredits)} cr` : model.vendor;
            const descId = `model-est-${model.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
            return (
              <PromptInputSelectItem
                key={model.id}
                value={toChoiceValue({ modelId: model.id })}
                data-tag={tag}
                aria-describedby={mCredits !== null ? descId : undefined}
                description={
                  mCredits !== null ? (
                    <span id={descId} className="sr-only">
                      {`Estimated ${formatCredits(mCredits)} credits per edit`}
                    </span>
                  ) : undefined
                }
                className={TAGGED_ITEM}
              >
                {model.name}
              </PromptInputSelectItem>
            );
          })}
        </SelectGroup>
        {promoModels.length > 0 && (
          <SelectGroup>
            <SelectLabel>Free promotion</SelectLabel>
            {promoModels.map((model) => (
              <PromptInputSelectItem
                key={model.id}
                value={toChoiceValue({ modelId: model.id })}
                data-tag={promoLimit(model.access)}
                className={TAGGED_ITEM}
              >
                {model.name}
              </PromptInputSelectItem>
            ))}
          </SelectGroup>
        )}
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
