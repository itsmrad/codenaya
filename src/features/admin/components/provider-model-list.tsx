"use client";

import { useEffect, useMemo, useState } from "react";
import ky from "ky";
import { RefreshCwIcon, SearchIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { aiProviderRequestError } from "@/features/ai-providers/hooks/use-ai-providers";
import { blendPrices } from "@/features/ai-providers/catalog";
import { cn } from "@/lib/utils";

import type { ListedModel } from "../catalog-draft";
import type { PlatformProviderId } from "../platform-models";

/**
 * A provider's live model list (`GET /api/admin/models`) with search, for the
 * Add models and Change route dialogs. Lists are kept for the page's life so
 * reopening a dialog doesn't spend the route's rate limit; Refresh refetches.
 */

const lists = new Map<PlatformProviderId, Promise<ListedModel[]>>();

const loadModels = (provider: PlatformProviderId) => {
  const kept = lists.get(provider);
  if (kept) return kept;
  const list = ky
    .get("/api/admin/models", { searchParams: { provider }, timeout: 20_000 })
    .json<{ models: ListedModel[] }>()
    .then((body) => body.models);
  // A failure isn't kept: the next open tries again.
  list.catch(() => lists.get(provider) === list && lists.delete(provider));
  lists.set(provider, list);
  return list;
};

function useProviderModels(provider: PlatformProviderId) {
  const [result, setResult] = useState<{ provider: PlatformProviderId; models?: ListedModel[]; error?: string }>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    loadModels(provider).then(
      (models) => current && setResult({ provider, models }),
      async (error) => {
        const message = await aiProviderRequestError(error);
        if (current) setResult({ provider, error: message });
      },
    );
    return () => {
      current = false;
    };
  }, [provider, attempt]);

  const loaded = result?.provider === provider ? result : undefined;
  return {
    models: loaded?.models,
    error: loaded?.error,
    refresh: () => {
      lists.delete(provider);
      setResult(undefined);
      setAttempt((n) => n + 1);
    },
  };
}

/** "$8/M", "≈$8/M ref" (OpenRouter's price) or nothing known. */
const PriceHint = ({ model }: { model: ListedModel }) => {
  if (model.inputUsdPerMTok !== undefined && model.outputUsdPerMTok !== undefined) {
    return <span>${Number(blendPrices(model.inputUsdPerMTok, model.outputUsdPerMTok).toFixed(4))}/M</span>;
  }
  if (model.referencePrice !== undefined) {
    return <span title="OpenRouter's price for this model, as a reference">≈${model.referencePrice}/M ref</span>;
  }
  return <span className="text-muted-foreground">No price</span>;
};

interface ProviderModelListProps {
  provider: PlatformProviderId;
  /** Several (Add models) or one (Change route). */
  mode: "multiple" | "single";
  selected: ReadonlySet<string>;
  onSelect: (model: ListedModel, selected: boolean) => void;
  /** Ids already in the catalog: shown as added, not selectable. */
  addedIds?: ReadonlySet<string>;
  /** How many more may be selected. */
  room?: number;
}

export const ProviderModelList = ({
  provider,
  mode,
  selected,
  onSelect,
  addedIds,
  room = Infinity,
}: ProviderModelListProps) => {
  const { models, error, refresh } = useProviderModels(provider);
  const [search, setSearch] = useState("");

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (models ?? []).filter(
      (m) => !query || `${m.name} ${m.id} ${m.vendor}`.toLowerCase().includes(query),
    );
  }, [models, search]);

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t fetch models</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-2">
          {error}
          <Button variant="outline" size="sm" onClick={refresh}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const rows = visible.map((model) => {
    const isAdded = addedIds?.has(model.id) ?? false;
    const isChecked = isAdded || selected.has(model.id);
    // The agent can't run a model without tool calling.
    const disabled = isAdded || model.tools === false || (!isChecked && mode === "multiple" && selected.size >= room);
    const id = `listed-${provider}-${model.id}`;
    return (
      <li
        key={model.id}
        className={cn("flex items-center gap-3 px-3 py-2 text-sm", !disabled && "hover:bg-muted/50", disabled && "opacity-60")}
      >
        {mode === "multiple" ? (
          <Checkbox
            id={id}
            checked={isChecked}
            disabled={disabled}
            onCheckedChange={(checked) => onSelect(model, checked === true)}
          />
        ) : (
          <RadioGroupItem id={id} value={model.id} disabled={disabled} />
        )}
        <Label htmlFor={id} className="min-w-0 flex-1 flex-col items-start gap-0.5 font-normal">
          <span className="w-full truncate font-medium">{model.name}</span>
          <span className="w-full truncate font-mono text-xs text-muted-foreground">{model.id}</span>
        </Label>
        <span className="hidden text-right text-xs tabular-nums sm:block">
          <PriceHint model={model} />
        </span>
        {isAdded && <Badge>Added</Badge>}
        {model.tools === false && <Badge variant="outline">No tools</Badge>}
      </li>
    );
  });


  const renderList = () => {
    if (!models) {
      return (
        <div className="space-y-2" aria-label="Loading models">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-11 w-full" />
          ))}
        </div>
      );
    }
    if (visible.length === 0) {
      return <p className="py-8 text-center text-sm text-muted-foreground">No models match.</p>;
    }
    return (
      <ScrollArea className="h-[min(24rem,50vh)] rounded-md border">
        {mode === "multiple" ? (
          <ul className="divide-y">{rows}</ul>
        ) : (
          <RadioGroup
            value={[...selected][0] ?? ""}
            onValueChange={(id) => onSelect(visible.find((m) => m.id === id)!, true)}
            aria-label="Model"
            className="gap-0"
          >
            <ul className="divide-y">{rows}</ul>
          </RadioGroup>
        )}
      </ScrollArea>
    );
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, id or vendor"
            aria-label="Search models"
          />
        </InputGroup>
        <Button variant="outline" size="icon" onClick={refresh} disabled={!models} aria-label="Refresh the list">
          {models ? <RefreshCwIcon aria-hidden="true" /> : <Spinner />}
        </Button>
      </div>

      {renderList()}
      {models && (
        <p className="text-xs text-muted-foreground tabular-nums">
          Showing {visible.length} of {models.length}
        </p>
      )}
    </div>
  );
};
