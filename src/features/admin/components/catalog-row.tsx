"use client";

import { useState } from "react";
import { CircleAlertIcon, CircleCheckIcon, PencilIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

import { type DraftModel, toPricing } from "../catalog-draft";
import { adminPostErrorMessage, useAdminPost } from "../hooks/use-admin-post";
import type { PlatformProviderId } from "../platform-models";
import { ACCESS_LABELS } from "./model-sheet";

const usd = (n: number) => `$${Number(n.toFixed(4))}`;

/** The price as the row shows it, or null while it's missing or invalid. */
const priceSummary = (model: DraftModel) => {
  const pricing = toPricing(model);
  if (!pricing) return null;
  return pricing.mode === "blended"
    ? usd(pricing.usdPerMTok)
    : `${usd(pricing.inputUsdPerMTok)} in · ${usd(pricing.outputUsdPerMTok)} out`;
};

type TestState = { status: "idle" | "running" } | { status: "ok"; latencyMs: number } | { status: "error"; error: string };

/** Sends a tiny request through the model's route (`POST /api/admin/catalog/test`). */
const TestButton = ({ model }: { model: DraftModel }) => {
  const [state, setState] = useState<TestState>({ status: "idle" });
  const post = useAdminPost<
    { provider: PlatformProviderId; providerModelId: string },
    { ok: true; latencyMs: number } | { ok: false; error: string }
  >("/api/admin/catalog/test");

  const run = async () => {
    setState({ status: "running" });
    try {
      const result = await post({ provider: model.provider, providerModelId: model.providerModelId });
      setState(result.ok ? { status: "ok", latencyMs: result.latencyMs } : { status: "error", error: result.error });
    } catch (error) {
      setState({ status: "error", error: adminPostErrorMessage(error) });
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" size="sm" onClick={run} disabled={state.status === "running"} aria-label={`Test ${model.name}'s route`}>
        {state.status === "running" && <Spinner />}
        Test
      </Button>
      <p role="status" className="max-w-56 text-right text-xs">
        {state.status === "ok" && (
          <span className="flex items-center gap-1 text-muted-foreground">
            <CircleCheckIcon className="size-3.5 shrink-0" aria-hidden="true" />
            OK · {state.latencyMs} ms
          </span>
        )}
        {state.status === "error" && (
          <span className="flex items-start gap-1 text-left text-destructive" title={state.error}>
            <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span className="line-clamp-3 break-words">{state.error}</span>
          </span>
        )}
      </p>
    </div>
  );
};

interface CatalogRowProps {
  model: DraftModel;
  providerLabel: string;
  isDefault: boolean;
  isUtility: boolean;
  onEdit: () => void;
}

/** One catalog model at a glance; its settings open in `ModelSheet`. */
export const CatalogRow = ({ model, providerLabel, isDefault, isUtility, onEdit }: CatalogRowProps) => {
  const price = priceSummary(model);
  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-6">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={onEdit}
            className="mr-1 max-w-full truncate text-left font-medium hover:underline focus-visible:underline focus-visible:outline-none"
          >
            {model.name}
          </button>
          {isDefault && <Badge>Default</Badge>}
          {isUtility && <Badge variant="secondary">Utility</Badge>}
          {model.access !== "everyone" && <Badge variant="outline">{ACCESS_LABELS[model.access]}</Badge>}
          {model.hidden && <Badge variant="outline">Hidden</Badge>}
          {model.vision && <Badge variant="outline">Vision</Badge>}
          {model.tools === null && <Badge variant="destructive">Confirm tools</Badge>}
        </div>
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0">{providerLabel}</span>
          <span aria-hidden="true">·</span>
          <span className="truncate font-mono" title={model.providerModelId}>
            {model.providerModelId}
          </span>
        </p>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 sm:contents">
        <div className="text-sm tabular-nums sm:w-44 sm:text-right">
          {price ? (
            <>
              <p className="whitespace-nowrap">{price}</p>
              <p className="text-xs text-muted-foreground">
                {model.priceMode === "blended" ? "blended " : ""}per 1M tokens
                {model.isReferencePrice && " · reference"}
              </p>
            </>
          ) : (
            <p className="flex items-center gap-1 text-destructive sm:justify-end">
              <CircleAlertIcon className="size-3.5" aria-hidden="true" />
              Set a price
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-start gap-2">
          <TestButton key={`${model.provider}:${model.providerModelId}`} model={model} />
          <Button variant="outline" size="sm" onClick={onEdit} aria-label={`Edit ${model.name}`}>
            <PencilIcon aria-hidden="true" />
            Edit
          </Button>
        </div>
      </div>
    </li>
  );
};
