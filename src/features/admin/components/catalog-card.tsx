"use client";

import { useState } from "react";
import { BoxesIcon, InfoIcon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";

import type { DraftModel } from "../catalog-draft";
import type { CatalogDraft } from "../hooks/use-catalog-draft";
import { MAX_PLATFORM_MODELS, type PlatformProviderId } from "../platform-models";
import { AddModelsDialog } from "./add-models-dialog";
import { CatalogRow } from "./catalog-row";
import { ModelSheet } from "./model-sheet";
import type { ProviderOption } from "./provider-picker";
import { RouteDialog } from "./route-dialog";

export const CatalogCard = ({
  draft,
  providers,
  keyedProviders,
  fallbackProviderLabel,
}: {
  draft: CatalogDraft;
  /** Every platform provider, for labels. */
  providers: ProviderOption[];
  /** Providers with a key set: the only routes a model can take. */
  keyedProviders: ProviderOption[];
  /** `NEXT_PUBLIC_AI_PROVIDER`'s label: whose curated models users get until a catalog is saved. */
  fallbackProviderLabel: string;
}) => {
  const [pendingRemove, setPendingRemove] = useState<DraftModel | null>(null);
  const [rerouting, setRerouting] = useState<DraftModel | null>(null);
  // By id, so the sheet shows the draft's live values.
  const [editingId, setEditingId] = useState<string | null>(null);
  const models = draft.draft?.models ?? [];
  const editing = models.find((m) => m.id === editingId) ?? null;
  const label = (id: PlatformProviderId) => providers.find((p) => p.id === id)?.label ?? id;

  const renderBody = () => {
    if (!draft.draft) {
      return (
        <div className="space-y-2" aria-label="Loading models">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      );
    }
    if (models.length === 0) {
      return (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BoxesIcon />
            </EmptyMedia>
            <EmptyTitle>No models in the catalog</EmptyTitle>
            <EmptyDescription>Add models from a provider to start one.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      );
    }
    return (
      <ul aria-label="Catalog models" className="divide-y">
        {models.map((model) => (
          <CatalogRow
            key={model.id}
            model={model}
            providerLabel={label(model.provider)}
            isDefault={model.id === draft.draft?.defaultModelId}
            isUtility={model.id === draft.draft?.utilityModelId}
            onEdit={() => setEditingId(model.id)}
          />
        ))}
      </ul>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Catalog</CardTitle>
        <CardAction className="flex items-center gap-2">
          {models.length > 0 && (
            <Badge variant="outline" className="tabular-nums">
              {models.length} / {MAX_PLATFORM_MODELS}
            </Badge>
          )}
          <AddModelsDialog draft={draft} providers={keyedProviders} />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {draft.draft && !draft.hasSaved && (
          <Alert>
            <InfoIcon aria-hidden="true" />
            <AlertDescription>
              No catalog is saved yet, so users get {fallbackProviderLabel}&apos;s curated models.
              Save one here to replace them.
            </AlertDescription>
          </Alert>
        )}
        {renderBody()}
      </CardContent>

      <ModelSheet
        model={editing}
        draft={draft}
        providerLabel={editing ? label(editing.provider) : ""}
        onReroute={() => setRerouting(editing)}
        onRemove={() => setPendingRemove(editing)}
        onClose={() => setEditingId(null)}
      />

      <RouteDialog
        model={rerouting}
        providers={keyedProviders}
        providerLabel={label}
        onClose={() => setRerouting(null)}
        onConfirm={(provider, listed) => {
          if (rerouting) draft.reroute(rerouting.id, provider, listed);
          setRerouting(null);
        }}
      />

      <AlertDialog open={!!pendingRemove} onOpenChange={(open) => !open && setPendingRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {pendingRemove?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Once you save, users can&apos;t pick it, and chats that used it run on the default
              model.
              {(pendingRemove?.id === draft.draft?.defaultModelId ||
                pendingRemove?.id === draft.draft?.utilityModelId) &&
                " It's the default or utility model: the first eligible model takes over, which you can change before saving."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!pendingRemove) return;
                draft.remove(pendingRemove.id);
                setEditingId(null);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
};
