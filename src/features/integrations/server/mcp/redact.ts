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
 * Credential-shaped token patterns.
 *
 * Each is anchored on a provider prefix rather than raw entropy, because
 * entropy alone flags base64 payloads, hashes, UUIDs and minified code. Prefixed
 * matching has a far lower false-positive rate.
 */
const TOKEN_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  // GitHub: ghp_, gho_, ghu_, ghs_, ghr_, github_pat_
  { label: "github", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { label: "github-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  // Stripe live/test secret and restricted keys.
  { label: "stripe", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  // Supabase personal access tokens and service-role JWTs.
  { label: "supabase-pat", pattern: /\bsbp_[A-Za-z0-9]{20,}\b/g },
  // OpenAI-style.
  { label: "openai", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  // Slack.
  { label: "slack", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  // Google API keys.
  { label: "google", pattern: /\bAIza[A-Za-z0-9_-]{30,}\b/g },
  // AWS access key ids.
  { label: "aws", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  // JWTs — three base64url segments. Service-role keys are commonly JWTs.
  {
    label: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
];

/**
 * Passwords inside connection strings.
 *
 * The password is replaced while scheme, host, port and database name survive, so
 * the agent can still reason about the topology (and still knows a DSN was
 * returned) without the secret travelling into the transcript.
 */
const DSN_PASSWORD_PATTERN =
  /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@/]+)@/gi;

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
 */
export function redactSecrets(
  text: string,
  knownSecrets: readonly string[] = [],
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

  for (const { label, pattern } of TOKEN_PATTERNS) {
    // Fresh RegExp each call: the module-level literals carry /g state via
    // lastIndex, and reusing them across calls skips matches unpredictably.
    const scoped = new RegExp(pattern.source, pattern.flags);
    const matches = result.match(scoped);
    if (matches) {
      redactionCount += matches.length;
      matchedRules.add(label);
      result = result.replace(scoped, REDACTION_PLACEHOLDER);
    }
  }

  const dsn = new RegExp(DSN_PASSWORD_PATTERN.source, DSN_PASSWORD_PATTERN.flags);
  const dsnMatches = result.match(dsn);
  if (dsnMatches) {
    redactionCount += dsnMatches.length;
    matchedRules.add("dsn-password");
    result = result.replace(dsn, `$1:${REDACTION_PLACEHOLDER}@`);
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
 */
export function redactJsonValue(
  value: unknown,
  knownSecrets: readonly string[] = [],
): { value: unknown; redactionCount: number; matchedRules: string[] } {
  let redactionCount = 0;
  const matchedRules = new Set<string>();

  const walk = (input: unknown): unknown => {
    if (typeof input === "string") {
      const outcome = redactSecrets(input, knownSecrets);
      redactionCount += outcome.redactionCount;
      outcome.matchedRules.forEach((rule) => matchedRules.add(rule));
      return outcome.text;
    }

    if (Array.isArray(input)) {
      return input.map(walk);
    }

    if (input !== null && typeof input === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(input)) {
        output[key] = walk(nested);
      }
      return output;
    }

    return input;
  };

  const redacted = walk(value);

  return {
    value: redacted,
    redactionCount,
    matchedRules: [...matchedRules].sort(),
  };
}
