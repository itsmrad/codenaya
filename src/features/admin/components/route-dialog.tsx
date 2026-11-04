"use client";

import { useState } from "react";
import { ArrowRightIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { type DraftModel, type ListedModel, reroute } from "../catalog-draft";
import type { PlatformProviderId } from "../platform-models";
import { type ProviderOption, ProviderPicker } from "./provider-picker";
import { ProviderModelList } from "./provider-model-list";

interface RouteDialogProps {
  /** The model being re-routed; null keeps the dialog closed. */
  model: DraftModel | null;
  providers: ProviderOption[];
  providerLabel: (provider: PlatformProviderId) => string;
  onClose: () => void;
  onConfirm: (provider: PlatformProviderId, listed: ListedModel) => void;
}

/** Pick the new route, then confirm it: a re-route changes who serves every user's runs. */
const RouteSteps = ({ model, providers, providerLabel, onClose, onConfirm }: RouteDialogProps & { model: DraftModel }) => {
  const [provider, setProvider] = useState(
    providers.some((p) => p.id === model.provider) ? model.provider : providers[0]?.id,
  );
  const [picked, setPicked] = useState<ListedModel | null>(null);
  const [confirming, setConfirming] = useState(false);

  if (!provider) {
    return <p className="text-sm text-muted-foreground">No provider has a platform key yet.</p>;
  }

  if (confirming && picked) {
    const next = reroute(model, provider, picked);
    return (
      <>
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{providerLabel(model.provider)}</Badge>
            <span className="font-mono text-xs">{model.providerModelId}</span>
            <ArrowRightIcon className="size-4 text-muted-foreground" aria-label="becomes" />
            <Badge>{providerLabel(provider)}</Badge>
            <span className="font-mono text-xs">{picked.id}</span>
          </div>
          <p className="text-muted-foreground">
            Users keep picking <span className="font-mono text-xs">{model.id}</span>; once you save, its
            runs go to {providerLabel(provider)} on our key there.{" "}
            {next.price
              ? `The price becomes $${next.price}/M${next.isReferencePrice ? " (OpenRouter's, as a reference)" : ""}; check it before saving.`
              : `${providerLabel(provider)} doesn't list a price, so set one before saving.`}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirming(false)}>
            Back
          </Button>
          <Button onClick={() => onConfirm(provider, picked)}>Change route</Button>
        </DialogFooter>
      </>
    );
  }

  const unchanged = picked?.id === model.providerModelId && provider === model.provider;
  return (
    <>
      <ProviderPicker
        providers={providers}
        value={provider}
        onChange={(next) => {
          setProvider(next);
          setPicked(null);
        }}
      />
      <ProviderModelList
        key={provider}
        provider={provider}
        mode="single"
        selected={new Set(picked ? [picked.id] : [])}
        onSelect={setPicked}
      />
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => setConfirming(true)} disabled={!picked || unchanged}>
          Next
        </Button>
      </DialogFooter>
    </>
  );
};

export const RouteDialog = (props: RouteDialogProps) => (
  <Dialog open={!!props.model} onOpenChange={(open) => !open && props.onClose()}>
    <DialogContent className="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>Change route{props.model ? ` for ${props.model.name}` : ""}</DialogTitle>
        <DialogDescription>
          Pick the provider and its model that serve this one. Only providers with a platform key
          are listed.
        </DialogDescription>
      </DialogHeader>
      {props.model && <RouteSteps key={props.model.id} {...props} model={props.model} />}
    </DialogContent>
  </Dialog>
);
