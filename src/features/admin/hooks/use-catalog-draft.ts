import { useState } from "react";
import { useQuery } from "convex/react";
import { toast } from "sonner";

import { api } from "../../../../convex/_generated/api";
import {
  type CatalogSaveBody,
  type Draft,
  type DraftModel,
  type ListedModel,
  addModels,
  draftProblems,
  removeModel,
  reroute,
  riskyModelNames,
  toDraft,
  toSaveBody,
} from "../catalog-draft";
import type { PlatformProviderId } from "../platform-models";
import { AdminRequestError, adminPostErrorMessage, useAdminPost } from "./use-admin-post";

/**
 * The /admin catalog editor's state: the saved catalog from Convex, the
 * admin's unsaved draft over it, and Save through `POST /api/admin/catalog`
 * (step-up and the risky-price confirm included). Pure rules live in
 * `catalog-draft.ts`.
 */
export function useCatalogDraft() {
  const saved = useQuery(api.platformCatalog.getForAdmin);
  const [edited, setEdited] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  // Set while the risky-price confirm is open: the models it names.
  const [riskyNames, setRiskyNames] = useState<string[] | null>(null);
  const post = useAdminPost<CatalogSaveBody, { ok: true }>("/api/admin/catalog");

  const draft = edited ?? (saved === undefined ? undefined : toDraft(saved));

  const edit = (change: (draft: Draft) => Draft) => {
    if (draft) setEdited(change(draft));
  };

  const update = (id: string, patch: Partial<DraftModel>) =>
    edit((d) => ({ ...d, models: d.models.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));

  const save = async (confirmRiskyPrices = false) => {
    if (!edited || draftProblems(edited).length > 0) return;
    setRiskyNames(null);
    setSaving(true);
    try {
      await post(toSaveBody(edited, confirmRiskyPrices));
      // Edits made while the request ran stay unsaved.
      setEdited((current) => (current === edited ? null : current));
      toast.success("Catalog saved. Users see the new models now.");
    } catch (error) {
      if (error instanceof AdminRequestError && error.code === "risky_price") {
        setRiskyNames(riskyModelNames(edited, saved ?? null));
      } else {
        toast.error(adminPostErrorMessage(error));
      }
    } finally {
      setSaving(false);
    }
  };

  return {
    draft,
    /** A catalog has been saved; null means users get the env provider's curated one. */
    hasSaved: !!saved,
    isDirty: edited !== null,
    saving,
    riskyNames,
    problems: draft ? draftProblems(draft) : [],
    add: (provider: PlatformProviderId, models: ListedModel[]) => edit((d) => addModels(d, provider, models)),
    remove: (id: string) => edit((d) => removeModel(d, id)),
    reroute: (id: string, provider: PlatformProviderId, listed: ListedModel) =>
      edit((d) => ({ ...d, models: d.models.map((m) => (m.id === id ? reroute(m, provider, listed) : m)) })),
    update,
    setDefault: (defaultModelId: string) => edit((d) => ({ ...d, defaultModelId })),
    setUtility: (utilityModelId: string) => edit((d) => ({ ...d, utilityModelId })),
    discard: () => setEdited(null),
    save,
    cancelRiskySave: () => setRiskyNames(null),
  };
}

export type CatalogDraft = ReturnType<typeof useCatalogDraft>;
