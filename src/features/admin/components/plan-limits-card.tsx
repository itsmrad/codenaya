"use client";

import { useId, useState } from "react";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";

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
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  MAX_MONTHLY_TOKEN_LIMIT,
  MAX_MONTHLY_USD_LIMIT,
  MICRO_USD_PER_USD,
  formatTokens,
} from "@/features/ai-usage/limits";
import { PLANS } from "@/features/billing/plans";
import { convexErrorMessage } from "@/lib/convex-error";

import { api } from "../../../../convex/_generated/api";

type PlanLimitsRow = FunctionReturnType<typeof api.planLimits.listPlanLimits>[number];

/** One cap being edited: off means no cap of that kind. */
interface CapDraft {
  on: boolean;
  value: string;
}

interface CapSpec {
  label: string;
  unit: "usd" | "tokens";
  /** The slider covers the common range; the input takes anything up to `max`. */
  sliderMax: number;
  sliderStep: number;
  max: number;
}

const USD: CapSpec = { label: "Monthly spend", unit: "usd", sliderMax: 100, sliderStep: 1, max: MAX_MONTHLY_USD_LIMIT };
const TOKENS: CapSpec = {
  label: "Monthly tokens",
  unit: "tokens",
  sliderMax: 50_000_000,
  sliderStep: 100_000,
  max: MAX_MONTHLY_TOKEN_LIMIT,
};

/** The cap's number, or null when it can't be saved. */
const parseCap = (spec: CapSpec, value: string) => {
  const n = value.trim() === "" ? Number.NaN : Number(value);
  const ok = Number.isFinite(n) && n >= 0 && n <= spec.max && (spec.unit === "usd" || Number.isInteger(n));
  return ok ? n : null;
};

const draftOf = (cap: number | undefined, toValue: (n: number) => number): CapDraft => ({
  on: cap !== undefined,
  value: cap === undefined ? "" : String(toValue(cap)),
});

/** Compared as numbers, so "5.00" against a saved 5 is not a change. */
const changed = (spec: CapSpec, draft: CapDraft, saved: CapDraft) =>
  draft.on !== saved.on || (draft.on && parseCap(spec, draft.value) !== parseCap(spec, saved.value));

const CapField = ({
  spec,
  plan,
  draft,
  onChange,
}: {
  spec: CapSpec;
  plan: string;
  draft: CapDraft;
  onChange: (draft: CapDraft) => void;
}) => {
  const id = useId();
  const parsed = parseCap(spec, draft.value);
  const invalid = draft.on && parsed === null;
  const isUsd = spec.unit === "usd";

  return (
    <Field data-disabled={!draft.on || undefined}>
      <div className="flex items-center justify-between gap-3">
        <FieldLabel htmlFor={`${id}-input`}>{spec.label}</FieldLabel>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <label htmlFor={`${id}-switch`}>{draft.on ? "Capped" : "No limit"}</label>
          <Switch
            id={`${id}-switch`}
            checked={draft.on}
            onCheckedChange={(on) => onChange({ on, value: draft.value || "0" })}
            aria-label={`Cap ${plan} ${spec.label.toLowerCase()}`}
          />
        </div>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Slider
          className="sm:flex-1"
          min={0}
          max={spec.sliderMax}
          step={spec.sliderStep}
          value={[Math.min(parsed ?? 0, spec.sliderMax)]}
          onValueChange={([value]) => onChange({ ...draft, value: String(value) })}
          disabled={!draft.on}
          aria-label={`${plan} ${spec.label.toLowerCase()}`}
        />
        <InputGroup className="sm:w-44">
          {isUsd && (
            <InputGroupAddon>
              <InputGroupText>$</InputGroupText>
            </InputGroupAddon>
          )}
          <InputGroupInput
            id={`${id}-input`}
            type="number"
            inputMode={isUsd ? "decimal" : "numeric"}
            min={0}
            max={spec.max}
            step={isUsd ? "any" : 1}
            value={draft.on ? draft.value : ""}
            placeholder="No limit"
            disabled={!draft.on}
            aria-invalid={invalid}
            onChange={(e) => onChange({ ...draft, value: e.target.value })}
          />
          {!isUsd && (
            <InputGroupAddon align="inline-end">
              <InputGroupText>tokens</InputGroupText>
            </InputGroupAddon>
          )}
        </InputGroup>
      </div>
      {invalid ? (
        <FieldError>
          {isUsd
            ? `Enter an amount from $0 to $${formatTokens(spec.max)}.`
            : `Enter a whole number from 0 to ${formatTokens(spec.max)}.`}
        </FieldError>
      ) : (
        !isUsd &&
        draft.on &&
        parsed !== null && <FieldDescription>{formatTokens(parsed)} tokens, input and output combined</FieldDescription>
      )}
    </Field>
  );
};

/** One plan's monthly caps: edit, then save (audited). */
export const PlanLimitsCard = ({ row }: { row: PlanLimitsRow }) => {
  const plan = PLANS[row.planId];
  const initial = {
    usd: draftOf(row.costLimitMicroUsd, (micro) => micro / MICRO_USD_PER_USD),
    tokens: draftOf(row.tokenLimit, (n) => n),
  };
  const [usd, setUsd] = useState(initial.usd);
  const [tokens, setTokens] = useState(initial.tokens);
  const [saving, setSaving] = useState(false);
  const [confirmUnlimited, setConfirmUnlimited] = useState(false);
  const setPlanLimits = useMutation(api.planLimits.setPlanLimits);

  const usdValue = parseCap(USD, usd.value);
  const tokenValue = parseCap(TOKENS, tokens.value);
  const invalid = (usd.on && usdValue === null) || (tokens.on && tokenValue === null);
  const dirty = changed(USD, usd, initial.usd) || changed(TOKENS, tokens, initial.tokens);

  const save = async () => {
    setSaving(true);
    try {
      await setPlanLimits({
        planId: row.planId,
        ...(usd.on && usdValue !== null ? { monthlyUsdLimit: usdValue } : {}),
        ...(tokens.on && tokenValue !== null ? { monthlyTokenLimit: tokenValue } : {}),
      });
      toast.success(`${plan.name} limits saved. They apply to the next request.`);
    } catch (error) {
      toast.error(convexErrorMessage(error, `Couldn't save the ${plan.name} limits. Try again.`));
    } finally {
      setSaving(false);
    }
  };

  const onSave = () => (usd.on || tokens.on ? save() : setConfirmUnlimited(true));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {plan.name}
          {row.isDefault && <Badge variant="secondary">Default</Badge>}
        </CardTitle>
        <CardDescription>
          {plan.priceUsdPerMonth === 0 ? "Free" : `$${plan.priceUsdPerMonth}/month`}
        </CardDescription>
        {dirty && (
          <CardAction>
            <Badge variant="outline">Unsaved</Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-6">
        <CapField spec={USD} plan={plan.name} draft={usd} onChange={setUsd} />
        <CapField spec={TOKENS} plan={plan.name} draft={tokens} onChange={setTokens} />
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!dirty || saving}
          onClick={() => {
            setUsd(initial.usd);
            setTokens(initial.tokens);
          }}
        >
          Discard
        </Button>
        <Button size="sm" disabled={!dirty || invalid || saving} onClick={onSave}>
          {saving && <Spinner />}
          Save {plan.name}
        </Button>
      </CardFooter>

      <AlertDialog open={confirmUnlimited} onOpenChange={setConfirmUnlimited}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove every cap on {plan.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {plan.name} users could spend Codenaya AI without limit. Use 0 instead to turn platform AI
              off for this plan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={save}>Make unlimited</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
};
