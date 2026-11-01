"use client";

import { useMemo, useState } from "react";
import { PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

import type { ListedModel } from "../catalog-draft";
import type { CatalogDraft } from "../hooks/use-catalog-draft";
import { MAX_PLATFORM_MODELS } from "../platform-models";
import { type ProviderOption, ProviderPicker } from "./provider-picker";
import { ProviderModelList } from "./provider-model-list";

/** Picks models from a keyed provider's live list into the draft, each routed to that provider. */
export const AddModelsDialog = ({ draft, providers }: { draft: CatalogDraft; providers: ProviderOption[] }) => {
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState(providers[0]?.id);
  const [selected, setSelected] = useState<Map<string, ListedModel>>(new Map());

  const models = draft.draft?.models;
  const addedIds = useMemo(() => new Set(models?.map((m) => m.id)), [models]);
  const room = MAX_PLATFORM_MODELS - addedIds.size;

  const pickProvider = (next: typeof provider) => {
    setProvider(next);
    setSelected(new Map());
  };

  const select = (model: ListedModel, isSelected: boolean) =>
    setSelected((prev) => {
      const next = new Map(prev);
      if (isSelected) next.set(model.id, model);
      else next.delete(model.id);
      return next;
    });

  const add = () => {
    if (!provider) return;
    draft.add(provider, [...selected.values()]);
    setSelected(new Map());
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={!models || providers.length === 0}>
          <PlusIcon aria-hidden="true" />
          Add models
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add models</DialogTitle>
          <DialogDescription>
            Live from each provider with a platform key. A model runs on the provider you add it
            from; you can change its route later.
          </DialogDescription>
        </DialogHeader>
        {provider && (
          <>
            <ProviderPicker providers={providers} value={provider} onChange={pickProvider} />
            <ProviderModelList
              key={provider}
              provider={provider}
              mode="multiple"
              selected={new Set(selected.keys())}
              onSelect={select}
              addedIds={addedIds}
              room={room}
            />
          </>
        )}
        <DialogFooter className="items-center gap-3 sm:justify-between">
          <p className="text-xs text-muted-foreground tabular-nums">
            {room <= 0 ? `The ${MAX_PLATFORM_MODELS}-model limit is reached` : `Room for ${room} more`}
          </p>
          <Button onClick={add} disabled={selected.size === 0}>
            <PlusIcon aria-hidden="true" />
            {selected.size ? `Add ${selected.size} selected` : "Add selected"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
