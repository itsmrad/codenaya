"use client";

import React from "react";
import { formatDistanceToNow } from "date-fns";
import {
  EyeIcon,
  InfoIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
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

import type {
  ProviderDefinition,
  ScopeListField,
  ScopeStringField,
  ScopeValueSource,
} from "../types";

/**
 * Per-project scope editor for one linked connection.
 *
 * ## Why the fields are derived rather than listed
 *
 * The nine catalog providers scope themselves in four incompatible ways, and
 * `ProviderDefinition.scope` already declares which of them each provider
 * speaks (see `../types.ts`). This form reads those declarations and renders
 * only the controls a provider can actually honour. Hard-coding "Supabase gets
 * a project_ref box" would mean a second place to update per provider, and the
 * failure mode is silent: a control that looks like it narrows access but is
 * dropped by the URL builder.
 *
 * ## Two honesty constraints this form exists to satisfy
 *
 * 1. Five providers (`supportsReadOnly: false`) cannot express read-only in
 *    their MCP URL at all. The toggle still records the user's intent — the
 *    stored flag is what a tool-call gate would consult — but it does not
 *    restrict the server today, and the form says so instead of showing a
 *    reassuring green pill.
 * 2. Saving any scope change clears the connection's tool baseline server-side,
 *    because the exposed tool set is a function of the scope. That is surfaced
 *    before the user saves, not discovered afterwards when the tool count
 *    resets to zero.
 */

/** The scope shape `projectConnections.providerScope` persists. */
export interface ProviderScopeValue {
  projectRef?: string;
  categories?: string[];
  features?: string[];
  toolsets?: string[];
  orgSlug?: string;
  projectSlug?: string;
}

/** What the form hands back once the user saves. */
export interface ScopeFormValue {
  readOnly: boolean;
  /**
   * Mirrors `readOnly`: allowing writes is the deliberate act that grants write
   * approval, and switching read-only back on withdraws it.
   */
  writeApproved: boolean;
  providerScope: ProviderScopeValue;
}

const STRING_FIELD_LABELS: Record<ScopeStringField, string> = {
  projectRef: "Project reference",
  orgSlug: "Organisation slug",
  projectSlug: "Project slug",
};

const STRING_FIELD_PLACEHOLDERS: Record<ScopeStringField, string> = {
  projectRef: "Leave blank for every project this credential can reach",
  orgSlug: "my-organisation",
  projectSlug: "my-project",
};

const LIST_FIELD_LABELS: Record<ScopeListField, string> = {
  categories: "Tool categories",
  features: "Feature groups",
  toolsets: "Toolsets",
};

/** Destructive tool names named outright in the allow-writes confirmation. */
const DESTRUCTIVE_PREVIEW_COUNT = 4;

interface DeclaredScopeFields {
  strings: readonly ScopeStringField[];
  lists: readonly ScopeListField[];
  /** The wire name a field is sent under, shown so the user can verify it. */
  wireNames: Partial<Record<ScopeStringField | ScopeListField, string>>;
}

const EMPTY_FIELDS: DeclaredScopeFields = {
  strings: [],
  lists: [],
  wireNames: {},
};

/**
 * Which scope fields a provider actually reads, in the order it declares them.
 *
 * Path segments count as declared fields even though they carry no parameter
 * name — Sentry's organisation and project live in the URL path.
 */
const collectDeclaredFields = (
  provider: ProviderDefinition | undefined
): DeclaredScopeFields => {
  if (!provider) return EMPTY_FIELDS;

  const strings: ScopeStringField[] = [];
  const lists: ScopeListField[] = [];
  const wireNames: Partial<Record<ScopeStringField | ScopeListField, string>> =
    {};

  const note = (source: ScopeValueSource, wireName: string) => {
    if (source.kind === "string") {
      if (!strings.includes(source.field)) strings.push(source.field);
      wireNames[source.field] ??= wireName;
      return;
    }
    if (source.kind === "list") {
      if (!lists.includes(source.field)) lists.push(source.field);
      wireNames[source.field] ??= wireName;
    }
  };

  for (const rule of provider.scope.queryParams) note(rule.value, rule.param);
  for (const rule of provider.scope.headers) note(rule.value, rule.header);

  const path = provider.scope.path;
  if (path?.kind === "segments") {
    for (const field of path.segments) {
      if (!strings.includes(field)) strings.push(field);
    }
  }

  return { strings, lists, wireNames };
};

/** Trim, drop blanks, de-duplicate, sort — the normalisation the URL builder does. */
const normaliseList = (values: readonly string[]): string[] => {
  const cleaned = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed !== "") cleaned.add(trimmed);
  }
  return [...cleaned].sort();
};

const parseListInput = (raw: string): string[] =>
  normaliseList(raw.split(","));

/**
 * A one-line, human-readable summary of a stored scope.
 *
 * Exported for the project panel so the list and the editor cannot drift into
 * describing the same scope differently.
 */
export const describeProviderScope = (
  provider: ProviderDefinition | undefined,
  scope: ProviderScopeValue
): string[] => {
  const declared = collectDeclaredFields(provider);
  const parts: string[] = [];

  for (const field of declared.strings) {
    const value = scope[field]?.trim();
    if (value) parts.push(`${STRING_FIELD_LABELS[field]} ${value}`);
  }

  for (const field of declared.lists) {
    const selected = scope[field] ?? [];
    if (selected.length === 0) continue;
    const total = provider?.scopeOptions?.[field]?.length;
    parts.push(
      total
        ? `${selected.length} of ${total} ${LIST_FIELD_LABELS[field].toLowerCase()}`
        : `${selected.length} ${LIST_FIELD_LABELS[field].toLowerCase()}`
    );
  }

  return parts;
};

interface ConnectionScopeFormProps {
  /** Catalog entry, or `undefined` for a custom MCP server. */
  provider: ProviderDefinition | undefined;
  /** Provider name for prose; falls back to the stored provider id. */
  providerName: string;
  /** The user's own label for the credential. */
  connectionLabel: string;
  initialReadOnly: boolean;
  initialScope: ProviderScopeValue;
  /** Tools recorded for the current scope, if any have been discovered. */
  toolCount?: number;
  toolBaselineAt?: number;
  onSubmit: (value: ScopeFormValue) => Promise<void>;
  onCancel: () => void;
}

export const ConnectionScopeForm = ({
  provider,
  providerName,
  connectionLabel,
  initialReadOnly,
  initialScope,
  toolCount,
  toolBaselineAt,
  onSubmit,
  onCancel,
}: ConnectionScopeFormProps) => {
  const declared = React.useMemo(
    () => collectDeclaredFields(provider),
    [provider]
  );

  const fieldPrefix = React.useId();

  const [readOnly, setReadOnly] = React.useState(initialReadOnly);
  const [confirmWritesOpen, setConfirmWritesOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  const [strings, setStrings] = React.useState<
    Record<ScopeStringField, string>
  >(() => ({
    projectRef: initialScope.projectRef ?? "",
    orgSlug: initialScope.orgSlug ?? "",
    projectSlug: initialScope.projectSlug ?? "",
  }));

  // A list with no stored value has never been narrowed, so it starts at the
  // provider's own defaults. Starting empty would look like "nothing selected"
  // and, on save, silently hand back the provider default anyway.
  const [lists, setLists] = React.useState<Record<ScopeListField, string[]>>(
    () => {
      const initial = (field: ScopeListField): string[] => {
        const stored = initialScope[field];
        if (stored !== undefined) return normaliseList(stored);
        const options = provider?.scopeOptions?.[field];
        if (!options) return [];
        return normaliseList(
          options.filter((option) => option.enabledByDefault).map((o) => o.id)
        );
      };

      return {
        categories: initial("categories"),
        features: initial("features"),
        toolsets: initial("toolsets"),
      };
    }
  );

  // Free-text mirror for list fields the catalog declares but has no verified
  // option list for (GitHub toolsets). Kept as raw text so typing a separator
  // is not fought by re-parsing on every keystroke.
  const [listText, setListText] = React.useState<
    Record<ScopeListField, string>
  >(() => ({
    categories: (initialScope.categories ?? []).join(", "),
    features: (initialScope.features ?? []).join(", "),
    toolsets: (initialScope.toolsets ?? []).join(", "),
  }));

  const optionsFor = (field: ScopeListField) =>
    provider?.scopeOptions?.[field];

  const resolveList = (field: ScopeListField): string[] =>
    optionsFor(field) ? normaliseList(lists[field]) : parseListInput(listText[field]);

  const toggleListValue = (field: ScopeListField, id: string) => {
    setLists((current) => {
      const selected = current[field];
      const next = selected.includes(id)
        ? selected.filter((value) => value !== id)
        : [...selected, id];
      return { ...current, [field]: normaliseList(next) };
    });
  };

  // Sentry's URL builder throws when a project slug arrives without an
  // organisation slug, so the pairing is caught here where it can be explained.
  const needsOrgSlug =
    declared.strings.includes("projectSlug") &&
    declared.strings.includes("orgSlug") &&
    strings.projectSlug.trim() !== "" &&
    strings.orgSlug.trim() === "";

  // An empty checkbox group means "send nothing", which the provider reads as
  // "everything" — the opposite of what an empty list looks like on screen.
  const emptyListFields = declared.lists.filter(
    (field) => optionsFor(field) !== undefined && lists[field].length === 0
  );

  const hasBlockingError = needsOrgSlug || emptyListFields.length > 0;

  const buildValue = (): ScopeFormValue => {
    const providerScope: ProviderScopeValue = {};

    for (const field of declared.strings) {
      const value = strings[field].trim();
      if (value !== "") providerScope[field] = value;
    }

    for (const field of declared.lists) {
      const values = resolveList(field);
      if (values.length > 0) providerScope[field] = values;
    }

    return { readOnly, writeApproved: !readOnly, providerScope };
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (hasBlockingError || submitting) return;

    setSubmitting(true);
    try {
      await onSubmit(buildValue());
    } finally {
      setSubmitting(false);
    }
  };

  const readOnlyEnforced = provider?.supportsReadOnly ?? false;
  const destructiveTools = provider?.destructiveTools ?? [];
  const readOnlySwitchId = `${fieldPrefix}-read-only`;

  const readOnlyDescription = readOnly
    ? readOnlyEnforced
      ? `${providerName} is asked for its read-only endpoint, so write tools are not offered to the agent.`
      : `${providerName} has no read-only mode we can request, so this records your intent only — see the note below.`
    : `The agent may call tools that change data in ${providerName}.`;

  const baselineNote = (
    <div className="flex items-start gap-2 rounded-lg border border-border/50 bg-muted/20 p-2.5">
      <RotateCcwIcon
        aria-hidden="true"
        className="size-3.5 shrink-0 mt-0.5 text-muted-foreground"
      />
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Saving re-scopes this connection, so the recorded tool list is cleared:
        the next agent run discovers the tools again and anything destructive
        has to be approved again.
        {toolCount !== undefined && (
          <>
            {" "}
            {toolCount} {toolCount === 1 ? "tool" : "tools"} recorded
            {toolBaselineAt !== undefined
              ? ` ${formatDistanceToNow(toolBaselineAt, { addSuffix: true })}`
              : ""}{" "}
            will no longer be counted as current.
          </>
        )}
      </p>
    </div>
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1">
        <h4 className="text-xs font-medium text-foreground">
          Scope for {connectionLabel}
        </h4>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          These choices apply to this project only. The same credential can be
          linked to another project with a different scope.
        </p>
      </div>

      <Field orientation="horizontal">
        <FieldLabel htmlFor={readOnlySwitchId} className="flex-col items-start gap-1">
          <span className="flex items-center gap-1.5 text-xs font-medium">
            {readOnly ? (
              <EyeIcon aria-hidden="true" className="size-3.5" />
            ) : (
              <ShieldAlertIcon aria-hidden="true" className="size-3.5" />
            )}
            {readOnly ? "Read-only" : "Writes allowed"}
          </span>
          <FieldDescription className="text-[11px] leading-relaxed font-normal">
            {readOnlyDescription}
          </FieldDescription>
        </FieldLabel>
        <Switch
          id={readOnlySwitchId}
          checked={readOnly}
          onCheckedChange={(checked) => {
            // Turning read-only off is the one change here that widens access,
            // so it goes through a confirmation instead of taking effect on a
            // single click.
            if (checked) {
              setReadOnly(true);
              return;
            }
            setConfirmWritesOpen(true);
          }}
        />
      </Field>

      {!readOnlyEnforced && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5">
          <TriangleAlertIcon
            aria-hidden="true"
            className="size-3.5 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400"
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">
              Read-only is not enforced for {providerName}.
            </span>{" "}
            Its MCP endpoint has no read-only mode, so the toggle above records
            what you intend rather than restricting the server. Per-tool
            approval, which is what would actually block a write, is not in
            place yet — treat this connection as capable of writing whichever
            way the toggle is set.
          </p>
        </div>
      )}

      {declared.strings.map((field) => {
        const inputId = `${fieldPrefix}-${field}`;
        const wireName = declared.wireNames[field];
        const invalid = field === "orgSlug" && needsOrgSlug;

        return (
          <Field key={field} data-invalid={invalid}>
            <FieldLabel htmlFor={inputId} className="text-xs font-medium">
              {STRING_FIELD_LABELS[field]}
            </FieldLabel>
            <Input
              id={inputId}
              name={field}
              value={strings[field]}
              aria-invalid={invalid}
              placeholder={STRING_FIELD_PLACEHOLDERS[field]}
              onChange={(event) =>
                setStrings((current) => ({
                  ...current,
                  [field]: event.target.value,
                }))
              }
            />
            <FieldDescription className="text-[11px] leading-relaxed">
              {field === "projectRef" && wireName
                ? `Sent as ${wireName}. Naming one project is the narrowest scope this provider offers.`
                : field === "orgSlug"
                  ? `Added to the MCP URL path. Required before a project slug can be used.`
                  : field === "projectSlug"
                    ? "Added to the MCP URL path, inside the organisation above."
                    : wireName
                      ? `Sent as ${wireName}.`
                      : "Added to the MCP URL path."}
            </FieldDescription>
            {invalid && (
              <FieldError className="text-[11px]">
                Add the organisation slug as well. {providerName} addresses a
                project inside an organisation, and a project slug on its own is
                rejected before the connection opens.
              </FieldError>
            )}
          </Field>
        );
      })}

      {declared.lists.map((field) => {
        const options = optionsFor(field);
        const legend = LIST_FIELD_LABELS[field];
        const wireName = declared.wireNames[field];

        if (!options) {
          const inputId = `${fieldPrefix}-${field}-text`;
          return (
            <Field key={field}>
              <FieldLabel htmlFor={inputId} className="text-xs font-medium">
                {legend}
              </FieldLabel>
              <Input
                id={inputId}
                name={field}
                value={listText[field]}
                placeholder="Leave blank for the provider's default set"
                onChange={(event) =>
                  setListText((current) => ({
                    ...current,
                    [field]: event.target.value,
                  }))
                }
              />
              <FieldDescription className="text-[11px] leading-relaxed">
                Comma-separated{wireName ? `, sent as ${wireName}` : ""}. We do
                not ship a verified list of {legend.toLowerCase()} for{" "}
                {providerName}, so this is free text — check their docs for the
                names. Blank means the provider chooses.
              </FieldDescription>
            </Field>
          );
        }

        const invalid = lists[field].length === 0;

        return (
          <FieldSet key={field} data-invalid={invalid} className="gap-2">
            <FieldLegend variant="label" className="mb-0 text-xs">
              {legend}
            </FieldLegend>
            <FieldDescription className="text-[11px] leading-relaxed">
              Ticked groups are the ones the agent can use
              {wireName ? `, sent as ${wireName}` : ""}. These start at{" "}
              {providerName}&apos;s own defaults, so nothing changes until you
              change it.
            </FieldDescription>
            <div className="grid grid-cols-2 gap-1.5">
              {options.map((option) => {
                const checkboxId = `${fieldPrefix}-${field}-${option.id}`;
                const checked = lists[field].includes(option.id);

                return (
                  <div key={option.id} className="flex items-center gap-2">
                    <Checkbox
                      id={checkboxId}
                      checked={checked}
                      onCheckedChange={() => toggleListValue(field, option.id)}
                    />
                    <FieldLabel
                      htmlFor={checkboxId}
                      className={cn(
                        "text-[11px] font-normal",
                        !checked && "text-muted-foreground"
                      )}
                    >
                      {option.id}
                      {!option.enabledByDefault && (
                        <span className="text-[10px] text-muted-foreground/70">
                          off by default
                        </span>
                      )}
                    </FieldLabel>
                  </div>
                );
              })}
            </div>
            {invalid && (
              <FieldError className="text-[11px]">
                Pick at least one. Sending none is read by {providerName} as
                &quot;no restriction&quot;, which would widen access instead of
                narrowing it.
              </FieldError>
            )}
          </FieldSet>
        );
      })}

      {declared.strings.length === 0 && declared.lists.length === 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-border/50 bg-muted/20 p-2.5">
          <InfoIcon
            aria-hidden="true"
            className="size-3.5 shrink-0 mt-0.5 text-muted-foreground"
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {providerName} exposes no way to narrow its MCP endpoint, so
            read-only is the only choice available here. Narrower access has to
            come from the credential itself.
          </p>
        </div>
      )}

      {baselineNote}

      <div className="flex items-center gap-2">
        <Button
          type="submit"
          size="sm"
          className="flex-1"
          disabled={submitting || hasBlockingError}
        >
          {submitting ? "Saving..." : "Save scope"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </Button>
      </div>

      <AlertDialog open={confirmWritesOpen} onOpenChange={setConfirmWritesOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Let the agent write to {providerName}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  {destructiveTools.length > 0
                    ? `The agent will be able to call ${providerName} tools that change or destroy data in this project's scope, including ${destructiveTools
                        .slice(0, DESTRUCTIVE_PREVIEW_COUNT)
                        .join(", ")}${
                        destructiveTools.length > DESTRUCTIVE_PREVIEW_COUNT
                          ? ` and ${
                              destructiveTools.length -
                              DESTRUCTIVE_PREVIEW_COUNT
                            } more`
                          : ""
                      }.`
                    : `The agent will no longer be limited to reading from ${providerName}. We do not track any destructive tools for this provider, so we cannot list what it might change.`}
                </p>
                <p>
                  Changes happen in the real service under your own credential —
                  Codenaya cannot undo them. You can switch read-only back on at
                  any time.
                </p>
                {!readOnlyEnforced && (
                  <p>
                    Note that {providerName} has no read-only endpoint, so
                    read-only was never enforced for this connection in the
                    first place.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep read-only</AlertDialogCancel>
            <AlertDialogAction onClick={() => setReadOnly(false)}>
              Allow writes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
};
