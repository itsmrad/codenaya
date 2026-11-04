"use client";

import { RouteIcon, Trash2Icon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import type { ModelAccess } from "@/features/ai-providers/catalog";

import { type DraftModel, parsePrice, togglePriceMode } from "../catalog-draft";
import type { CatalogDraft } from "../hooks/use-catalog-draft";

export const ACCESS_LABELS: Record<ModelAccess, string> = {
  everyone: "Everyone",
  promo_counted: "Promo · counted runs",
  promo_unlimited: "Promo · unlimited",
};

const PriceInput = ({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) => (
  <InputGroup>
    <InputGroupAddon>
      <InputGroupText>$</InputGroupText>
    </InputGroupAddon>
    <InputGroupInput
      id={id}
      type="number"
      inputMode="decimal"
      min={0}
      step="any"
      placeholder="Set"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-invalid={parsePrice(value) === null}
    />
    <InputGroupAddon align="inline-end">
      <InputGroupText>/M</InputGroupText>
    </InputGroupAddon>
  </InputGroup>
);

const PriceFields = ({ model, draft }: { model: DraftModel; draft: CatalogDraft }) => {
  const set = (patch: Partial<DraftModel>) => draft.update(model.id, { ...patch, isReferencePrice: false });
  const split = model.priceMode === "split";
  return (
    <FieldSet>
      <FieldLegend variant="label">Price</FieldLegend>
      <FieldDescription>
        What a run costs us, in USD per 1M tokens.
        {model.isReferencePrice && " This is OpenRouter's price for the model: check the provider's own."}
      </FieldDescription>
      {split ? (
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel htmlFor="model-price-input">Input</FieldLabel>
            <PriceInput id="model-price-input" value={model.input} onChange={(input) => set({ input })} />
          </Field>
          <Field>
            <FieldLabel htmlFor="model-price-output">Output</FieldLabel>
            <PriceInput id="model-price-output" value={model.output} onChange={(output) => set({ output })} />
          </Field>
        </div>
      ) : (
        <Field>
          <FieldLabel htmlFor="model-price">Blended (3 input : 1 output)</FieldLabel>
          <PriceInput id="model-price" value={model.price} onChange={(price) => set({ price })} />
        </Field>
      )}
      <Field orientation="horizontal">
        <FieldLabel htmlFor="model-price-split" className="font-normal">
          Price input and output apart
        </FieldLabel>
        <Switch id="model-price-split" checked={split} onCheckedChange={() => draft.update(model.id, togglePriceMode(model))} />
      </Field>
    </FieldSet>
  );
};

/** A labelled switch with a line of help. */
const SwitchField = ({
  id,
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) => (
  <Field orientation="horizontal" data-disabled={disabled || undefined}>
    <FieldContent>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <FieldDescription>{description}</FieldDescription>
    </FieldContent>
    <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
  </Field>
);

interface ModelSheetProps {
  /** The model being edited, read live from the draft; null closes the sheet. */
  model: DraftModel | null;
  draft: CatalogDraft;
  providerLabel: string;
  onReroute: () => void;
  onRemove: () => void;
  onClose: () => void;
}

/** Every setting of one catalog model. Edits go into the draft; the save bar saves them. */
export const ModelSheet = ({ model, draft, providerLabel, onReroute, onRemove, onClose }: ModelSheetProps) => (
  <Sheet open={!!model} onOpenChange={(open) => !open && onClose()}>
    <SheetContent className="w-full gap-0 sm:max-w-md">
      {model && (
        <>
          <SheetHeader className="border-b pr-12">
            <SheetTitle className="truncate">{model.name}</SheetTitle>
            <SheetDescription className="truncate font-mono text-xs">{model.id}</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-4">
            <ModelFields model={model} draft={draft} providerLabel={providerLabel} onReroute={onReroute} />
          </div>
          <SheetFooter className="flex-row items-center justify-between border-t">
            <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={onRemove}>
              <Trash2Icon aria-hidden="true" />
              Remove
            </Button>
            <SheetClose asChild>
              <Button>Done</Button>
            </SheetClose>
          </SheetFooter>
        </>
      )}
    </SheetContent>
  </Sheet>
);

const ModelFields = ({
  model,
  draft,
  providerLabel,
  onReroute,
}: Pick<ModelSheetProps, "draft" | "providerLabel" | "onReroute"> & { model: DraftModel }) => {
  const forEveryone = model.access === "everyone";
  const isDefault = model.id === draft.draft?.defaultModelId;
  const isUtility = model.id === draft.draft?.utilityModelId;

  return (
    <FieldGroup className="gap-6">
      <FieldSet className="min-w-0">
        <FieldLegend variant="label">Route</FieldLegend>
        <div className="flex items-center justify-between gap-3 rounded-md border p-3">
          <div className="min-w-0 space-y-1">
            <Badge variant="secondary">{providerLabel}</Badge>
            <p className="truncate font-mono text-xs text-muted-foreground" title={model.providerModelId}>
              {model.providerModelId}
            </p>
          </div>
          <Button variant="outline" size="sm" className="shrink-0" onClick={onReroute}>
            <RouteIcon aria-hidden="true" />
            Change
          </Button>
        </div>
      </FieldSet>

      <FieldSeparator />
      <PriceFields model={model} draft={draft} />
      <FieldSeparator />

      <FieldSet>
        <FieldLegend variant="label">Capabilities</FieldLegend>
        <SwitchField
          id="model-vision"
          label="Accepts images"
          // AgentKit's Anthropic adapter is text-only, so images can never reach it.
          description={model.provider === "anthropic" ? "Not on the Anthropic route: it's text-only here." : "Users can attach screenshots and mockups."}
          checked={model.vision}
          disabled={model.provider === "anthropic"}
          onCheckedChange={(vision) => draft.update(model.id, { vision })}
        />
        {model.tools === "reported" ? (
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel>Tool calling</FieldLabel>
              <FieldDescription>Reported by the provider.</FieldDescription>
            </FieldContent>
            <Badge variant="secondary">Supported</Badge>
          </Field>
        ) : (
          <Field orientation="horizontal" data-invalid={model.tools === null || undefined}>
            <Checkbox
              id="model-tools"
              checked={model.tools === "confirmed"}
              onCheckedChange={(checked) => draft.update(model.id, { tools: checked === true ? "confirmed" : null })}
              aria-invalid={model.tools === null}
            />
            <FieldContent>
              <FieldLabel htmlFor="model-tools">Supports tool calling</FieldLabel>
              <FieldDescription>The provider doesn&apos;t say. The agent can&apos;t build without it, so confirm before saving.</FieldDescription>
            </FieldContent>
          </Field>
        )}
      </FieldSet>

      <FieldSeparator />

      <FieldSet>
        <FieldLegend variant="label">Availability</FieldLegend>
        <Field>
          <FieldLabel htmlFor="model-access">Who can pick it</FieldLabel>
          <Select value={model.access} onValueChange={(access) => draft.update(model.id, { access: access as ModelAccess })}>
            <SelectTrigger id="model-access" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(ACCESS_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <SwitchField
          id="model-hidden"
          label="Hidden"
          description="Left out of the model picker. Chats already on it keep running."
          checked={model.hidden}
          onCheckedChange={(hidden) => draft.update(model.id, { hidden })}
        />
      </FieldSet>

      <FieldSeparator />

      <FieldSet>
        <FieldLegend variant="label">Roles</FieldLegend>
        {/* On only: turning one on moves the role here, and there's always one holder. */}
        <SwitchField
          id="model-default"
          label="Default model"
          description={
            isDefault
              ? "New chats start on it. Make another model the default to move it."
              : forEveryone && !model.hidden
                ? "New chats start on this model."
                : "Only a visible model for everyone can be the default."
          }
          checked={isDefault}
          disabled={isDefault || !forEveryone || model.hidden}
          onCheckedChange={() => draft.setDefault(model.id)}
        />
        <SwitchField
          id="model-utility"
          label="Utility model"
          description={
            isUtility
              ? "Writes chat titles and runs editor AI. Pick another model to move it."
              : forEveryone
                ? "Writes chat titles and runs editor AI."
                : "Only a model for everyone can be the utility model."
          }
          checked={isUtility}
          disabled={isUtility || !forEveryone}
          onCheckedChange={() => draft.setUtility(model.id)}
        />
      </FieldSet>
    </FieldGroup>
  );
};
