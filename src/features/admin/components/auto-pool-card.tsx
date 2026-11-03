"use client";

import { CircleAlertIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";

import { blendedUsdPerMTok, pickableModels } from "../../ai-providers/catalog";
import { toPricing } from "../catalog-draft";
import type { CatalogDraft } from "../hooks/use-catalog-draft";

/**
 * The models Auto (#322) may route to. Edits go into the catalog draft and
 * save with it; only models users may pick can join.
 */
export const AutoPoolCard = ({ draft }: { draft: CatalogDraft }) => {
  const current = draft.draft;
  if (!current || current.models.length === 0) return null;
  const pool = new Set(current.autoModelIds);
  const pickable = new Set(pickableModels(current.models).map((m) => m.id));
  const usable = current.models.filter((m) => pool.has(m.id) && pickable.has(m.id));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Auto</CardTitle>
        <CardDescription>
          Pick the models Auto may choose from. First builds, plans and fixes go to the priciest
          one, short edits to the cheapest, and images only to models that read them. Pick none
          to keep Auto&apos;s built-in routes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {usable.length > 0 && !usable.some((m) => m.vision) && (
          <p className="flex items-center gap-1.5 text-sm text-destructive">
            <CircleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
            No model here reads images, so image sends on Auto are refused.
          </p>
        )}
        <ul aria-label="Auto models" className="divide-y">
          {current.models.map((model) => {
            const id = `auto-${model.id}`;
            const eligible = pickable.has(model.id);
            const pricing = toPricing(model);
            return (
              <li key={model.id} className="py-2">
                <Field orientation="horizontal" data-disabled={!eligible || undefined}>
                  <Checkbox
                    id={id}
                    checked={pool.has(model.id)}
                    disabled={!eligible}
                    onCheckedChange={(checked) => draft.setAuto(model.id, checked === true)}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor={id}>
                      {model.name}
                      {model.vision && <Badge variant="secondary">Images</Badge>}
                    </FieldLabel>
                    <FieldDescription>
                      {eligible
                        ? pricing
                          ? `$${Number(blendedUsdPerMTok(pricing).toFixed(4))}/M blended`
                          : "No price yet"
                        : "Hidden or not for everyone: Auto skips it."}
                    </FieldDescription>
                  </FieldContent>
                </Field>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
};
