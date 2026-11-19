import {
  CREDENTIAL_TOKEN_PATTERNS,
  DSN_PASSWORD_PATTERN,
} from "../../credential-guard";

/**
 * Redaction of MCP tool results before they reach the model.
 *
 * ## Why this is necessary
 *
 * MCP tools return whatever the remote server decides to return. A perfectly
 * legitimate call can echo a credential back:
 *
 * - Supabase `get_project_url` / `get_publishable_keys` return live keys.
 * - Neon `list_prisma_postgres_connection_strings` returns a DSN with a password.
 * - `execute_sql` against a settings or secrets table returns whatever is in it.
 *
 * Anything the model sees is written into the conversation, persisted in the
 * `messages` table, and replayed as context on every later turn. A secret that
 * lands there is effectively logged forever and shown to the user in the chat
 * transcript. So known secret values are stripped on the way back.
 *
 * ## What this is not
 *
 * This is defence in depth, not a guarantee. It cannot recognise a secret it was
 * not told about, and entropy heuristics catch obvious API-key shapes while
 * missing short or structured secrets. The primary control is scope: read-only by
 * default, narrow feature/category selection, and the approval gate for writes.
 * Redaction is what limits the damage when a tool returns more than expected.
 *
 * Redacting too much is a real cost — if we mangle a connection string the agent
 * is supposed to write into `.env`, the generated app breaks in a way that is hard
 * to trace. So the known-values pass is exact-match only, and the heuristic pass
 * is deliberately conservative.
 */

/** Replaces a redacted span. Distinctive so it is obvious in a transcript. */
export const REDACTION_PLACEHOLDER = "[redacted-by-codenaya]";

/**
 * Below this length, an exact-match secret is not worth redacting: short values
 * collide with ordinary words and identifiers, and replacing them corrupts
 * unrelated text.
 */
const MIN_EXACT_MATCH_LENGTH = 8;

/**
 * Nesting ceiling for `redactJsonValue`.
 *
 * Bounds work on a pathologically nested payload. Well beyond anything a real tool
 * result reaches, so it never truncates legitimate data.
 */
const MAX_REDACTION_DEPTH = 32;

/**
 * Public configuration that becomes an env ref, but only where refs are minted
 * (MCP tool results). Elsewhere it stays visible: it is not a secret.
 */
const PUBLIC_REF_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "supabase-url", pattern: /\bhttps:\/\/[a-z0-9]{20}\.supabase\.co\b/g },
  { label: "supabase-publishable", pattern: /\bsb_publishable_[A-Za-z0-9_-]{16,}\b/g },
];

/** Host, port, path and query after a DSN's `user:password@`, bounded like the pattern itself. */
const DSN_TAIL = "[^\\s\"'<>`]{0,2048}";
/** Sentence punctuation that follows a URL in prose rather than belonging to it. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;
const BEARER_PREFIX = /^(Bearer\s+)(.+)$/is;

/**
 * Replacement for a redacted span, given its text and rule. Known values (the
 * MCP credential, stored secrets) never reach it; they always get the placeholder.
 */
export type RefMinter = (value: string, rule: string) => string;

export interface RedactionResult {
  text: string;
  /** How many spans were replaced. Zero means the payload was clean. */
  redactionCount: number;
  /** Which rules fired, for the audit log. Never includes the values. */
  matchedRules: string[];
}

/**
 * Escape a value for use inside a RegExp.
 *
 * Necessary because known secrets are arbitrary strings and may contain regex
 * metacharacters; without escaping, a `+` or `(` in a token would either throw or
 * silently match the wrong thing.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip secrets from a tool result.
 *
 * @param text Raw text returned by the MCP server.
 * @param knownSecrets Values we already hold for this project — the credential
 * itself, plus every stored secret env var. These are matched exactly, which is
 * both precise and the highest-value case: it is exactly these values that must
 * never be echoed back.
 * @param toRef When given, pattern matches become env refs instead of the
 * placeholder, and public Supabase config is replaced too.
 */
export function redactSecrets(
  text: string,
  knownSecrets: readonly string[] = [],
  toRef?: RefMinter,
): RedactionResult {
  let result = text;
  let redactionCount = 0;
  const matchedRules = new Set<string>();

  // Longest first, so a value that contains a shorter one is replaced whole
  // rather than being broken up by the shorter match.
  const exactValues = [...new Set(knownSecrets)]
    .map((value) => value.trim())
    .filter((value) => value.length >= MIN_EXACT_MATCH_LENGTH)
    .sort((a, b) => b.length - a.length);

  for (const value of exactValues) {
    const pattern = new RegExp(escapeRegExp(value), "g");
    const matches = result.match(pattern);
    if (matches) {
      redactionCount += matches.length;
      matchedRules.add("known-value");
      result = result.replace(pattern, REDACTION_PLACEHOLDER);
    }
  }

  const patterns = toRef
    ? [...CREDENTIAL_TOKEN_PATTERNS, ...PUBLIC_REF_PATTERNS]
    : CREDENTIAL_TOKEN_PATTERNS;
  for (const { label, pattern } of patterns) {
    // Fresh RegExp each call: the module-level literals carry /g state via
    // lastIndex, and reusing them across calls skips matches unpredictably.
    const scoped = new RegExp(pattern.source, pattern.flags);
    const matches = result.match(scoped);
    if (matches) {
      redactionCount += matches.length;
      matchedRules.add(label);
      result = result.replace(scoped, (match) => {
        if (!toRef) return REDACTION_PLACEHOLDER;
        // A bearer ref holds the token only, not the "Bearer " scheme word.
        const bearer = label === "bearer" ? BEARER_PREFIX.exec(match) : null;
        return bearer ? `${bearer[1]}${toRef(bearer[2], label)}` : toRef(match, label);
      });
    }
  }

  // With refs, the whole connection string becomes the ref: its password alone
  // would be stored as a broken DATABASE_URL.
  const dsn = new RegExp(
    toRef ? `${DSN_PASSWORD_PATTERN.source}${DSN_TAIL}` : DSN_PASSWORD_PATTERN.source,
    DSN_PASSWORD_PATTERN.flags,
  );
  const dsnMatches = result.match(dsn);
  if (dsnMatches) {
    redactionCount += dsnMatches.length;
    matchedRules.add("dsn-password");
    result = result.replace(dsn, (match: string, prefix: string, password: string) => {
      const tail = match.slice(prefix.length + password.length + 2);
      // A known secret already replaced above is the placeholder now; never ref the placeholder.
      if (!toRef || password === REDACTION_PLACEHOLDER) {
        return `${prefix}:${REDACTION_PLACEHOLDER}@${tail}`;
      }
      const url = match.replace(TRAILING_PUNCTUATION, "");
      return `${toRef(url, "dsn-password")}${match.slice(url.length)}`;
    });
  }

  return {
    text: result,
    redactionCount,
    matchedRules: [...matchedRules].sort(),
  };
}

/**
 * Redact an arbitrary JSON-serialisable tool result.
 *
 * Serialising, redacting and reparsing would corrupt the shape when a
 * placeholder lands inside a non-string field, so strings are rewritten in place
 * and other primitives are left alone.
 *
 * Cycle- and depth-guarded. Tool results arrive as parsed JSON and so cannot
 * normally be circular, but a crash here would take down an agent run, and this
 * function also runs over tool *arguments* that reach us from the model. Guarding
 * is cheap; discovering the limit in production is not.
 */
export function redactJsonValue(
  value: unknown,
  knownSecrets: readonly string[] = [],
  toRef?: RefMinter,
): { value: unknown; redactionCount: number; matchedRules: string[] } {
  let redactionCount = 0;
  const matchedRules = new Set<string>();

  // Tracks the ancestors of the node being visited. A WeakSet of the whole
  // traversal would wrongly flag a value that legitimately appears twice in
  // sibling positions, so entries are removed on the way back up.
  const ancestors = new Set<object>();

  const walk = (input: unknown, depth: number): unknown => {
    if (typeof input === "string") {
      const outcome = redactSecrets(input, knownSecrets, toRef);
      redactionCount += outcome.redactionCount;
      outcome.matchedRules.forEach((rule) => matchedRules.add(rule));
      return outcome.text;
    }

    if (input === null || typeof input !== "object") {
      return input;
    }

    if (depth > MAX_REDACTION_DEPTH) {
      return "[omitted: nesting too deep]";
    }

    if (ancestors.has(input)) {
      return "[omitted: circular reference]";
    }

    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        return input.map((entry) => walk(entry, depth + 1));
      }

      const output: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(input)) {
        output[key] = walk(nested, depth + 1);
      }
      return output;
    } finally {
      ancestors.delete(input);
    }
  };

  const redacted = walk(value, 0);

  return {
    value: redacted,
    redactionCount,
    matchedRules: [...matchedRules].sort(),
  };
}
