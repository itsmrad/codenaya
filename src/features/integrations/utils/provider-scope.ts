import type {
  ProviderDefinition,
  ScopeListField,
  ScopeStringField,
  ScopeValueSource,
} from "../types";

/** The scope shape `projectConnections.providerScope` persists. */
export interface ProviderScopeValue {
  projectRef?: string;
  categories?: string[];
  features?: string[];
  toolsets?: string[];
  orgSlug?: string;
  projectSlug?: string;
}

export const STRING_FIELD_LABELS: Record<ScopeStringField, string> = {
  projectRef: "Project reference",
  orgSlug: "Organisation slug",
  projectSlug: "Project slug",
};

export const LIST_FIELD_LABELS: Record<ScopeListField, string> = {
  categories: "Tool categories",
  features: "Feature groups",
  toolsets: "Toolsets",
};

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
export const collectDeclaredFields = (
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
export const normaliseList = (values: readonly string[]): string[] => {
  const cleaned = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed !== "") cleaned.add(trimmed);
  }
  return [...cleaned].sort();
};

export const parseListInput = (raw: string): string[] =>
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
