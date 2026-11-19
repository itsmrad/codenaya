/**
 * Redaction for the sandbox output stream.
 *
 * ## Why this is necessary
 *
 * `api/sandbox/route.ts` pipes every line of install and dev-server output to the
 * browser over NDJSON so the user can watch their app boot. Once secrets are
 * injected into that sandbox, anything the running process prints can contain them:
 *
 * - Frameworks that log resolved configuration on startup.
 * - Stack traces embedding a connection string in a failed-connection message.
 * - `npm` scripts that echo their environment while debugging.
 * - A user's own `console.log(process.env)`.
 *
 * Without this, injecting secrets into the sandbox would deliver them straight to
 * the client watching the terminal — defeating the entire public/secret split.
 *
 * ## What is matched
 *
 * Each value's exact text (multi-line included), its trimmed text, and their
 * common encodings: base64 (standard and url-safe, padded and not), percent-encoding and
 * hex. At each position the longest match wins.
 *
 * ## Why a stateful redactor rather than a pure function
 *
 * Stream chunks are arbitrary byte boundaries. A secret can be split across two
 * writes — `"...postgres://user:pa"` then `"ssword@host..."` — and a per-chunk
 * replace would miss it. This holds back a tail of each chunk long enough to catch
 * a secret spanning the boundary. Matches are only committed once no later input
 * can change them, so the output is the same however the stream is split.
 */

/** Replaces a redacted span, matching the MCP redaction placeholder. */
export const STREAM_REDACTION_PLACEHOLDER = "[redacted]";

/** Replaces all output when the values to redact are unknown or too many to match. */
export const REDACTION_UNAVAILABLE_NOTICE = "[output hidden: secret redaction unavailable]";

/** Bounds on the value inventory; past either, output is suppressed rather than matched. */
export const MAX_REDACTED_VALUES = 256;
export const MAX_REDACTED_BYTES = 64 * 1024;

export interface StreamRedactor {
  /** Redact a chunk, holding back any partial-match tail. */
  push(chunk: string): string;
  /** Release whatever is buffered. Call when the stream ends. */
  flush(): string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The value and the encodings a process commonly prints it in. */
function encodingsOf(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const base64 = bytes.toString("base64");
  const base64Url = bytes.toString("base64url");
  const hex = bytes.toString("hex");
  return [
    value,
    base64,
    base64.replace(/=+$/, ""),
    base64Url,
    base64Url.padEnd(base64.length, "="),
    encodeURIComponent(value),
    hex,
    hex.toUpperCase(),
  ];
}

/** Every pattern to match, longest first, and their regex; null when the inventory is over its bounds. */
function matcherOrNull(secrets: readonly string[]): { known: string[]; pattern: RegExp } | null {
  const bytes = secrets.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0);
  if (secrets.length > MAX_REDACTED_VALUES || bytes > MAX_REDACTED_BYTES) return null;
  // Exact bytes, plus the trimmed form an app may print a padded value in.
  const values = [...new Set(secrets.flatMap((value) => [value, value.trim()]))]
    // Near-zero entropy, and redacting them would destroy unrelated output.
    .filter((value) => value.length > 2 && value.trim() !== "");
  // Longest first, so the regex alternation takes the longest match at a position.
  const known = [...new Set(values.flatMap(encodingsOf))].sort((a, b) => b.length - a.length);
  return { known, pattern: new RegExp(known.map(escapeRegExp).join("|"), "g") };
}

/** Hides everything, saying why once, for a stream whose secrets cannot be matched. */
function suppressingRedactor(): StreamRedactor {
  let noticeSent = false;
  const notice = () => {
    if (noticeSent) return "";
    noticeSent = true;
    return REDACTION_UNAVAILABLE_NOTICE;
  };
  return { push: notice, flush: notice };
}

/**
 * Create a redactor for a fixed set of secret values.
 *
 * Pass `null` when the values could not be loaded: the redactor then fails closed
 * and suppresses the output, as it does when the inventory exceeds its bounds.
 * Returns a pass-through when there is nothing to redact, so a project with no
 * secrets pays no per-chunk cost.
 */
export function createStreamRedactor(
  secrets: readonly string[] | null,
): StreamRedactor {
  let matcher: ReturnType<typeof matcherOrNull> = null;
  try {
    matcher = secrets === null ? null : matcherOrNull(secrets);
  } catch (error) {
    // Only the error's name: its message could quote a value.
    console.error("[stream-redactor] could not build the redaction patterns", error instanceof Error ? error.name : typeof error);
  }
  if (matcher === null) return suppressingRedactor();
  const { known, pattern } = matcher;

  if (known.length === 0) {
    return {
      push: (chunk) => chunk,
      flush: () => "",
    };
  }

  // The longest pattern minus one character: the most that can be pending without
  // already being a complete match.
  const holdBack = known[0].length - 1;

  /**
   * Whether a completed line can be released before the hold-back window.
   *
   * When no pattern contains a newline, no match can span one, so every match
   * starting before the last newline is already decided — which keeps the terminal
   * responsive. A multi-line secret (a PEM key) disables this, or its first line
   * would be released verbatim.
   */
  const newlineReleaseSafe = !known.some((value) => value.includes("\n"));

  /** Raw, not-yet-emitted input. Never holds placeholder text. */
  let buffer = "";

  /**
   * Redact every match in `text` that starts before `decided`. A match starting
   * there is final: no pattern starting there can reach past the input seen so far.
   * Returns the redacted text up to `cursor`, the end of the last match.
   */
  const redactMatches = (text: string, decided: number) => {
    let out = "";
    let cursor = 0;
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match && match.index < decided; match = pattern.exec(text)) {
      out += text.slice(cursor, match.index) + STREAM_REDACTION_PLACEHOLDER;
      cursor = pattern.lastIndex;
    }
    return { out, cursor };
  };

  /** Where a trailing partial prefix of a pattern starts, or -1 when the text ends clear of one. */
  const partialPrefixStart = (text: string): number => {
    // Under 3 characters, as with values, reveals next to nothing and would eat ordinary text.
    for (let i = Math.max(0, text.length - holdBack); i <= text.length - 3; i++) {
      const tail = text.slice(i);
      if (known.some((value) => value.startsWith(tail))) return i;
    }
    return -1;
  };

  return {
    push(chunk: string): string {
      buffer += chunk;
      const byLength = buffer.length - holdBack;
      const byNewline = newlineReleaseSafe ? buffer.lastIndexOf("\n") + 1 : 0;
      const decided = Math.max(byLength, byNewline);
      const { out, cursor } = redactMatches(buffer, decided);
      const end = Math.max(cursor, decided);
      const emit = out + buffer.slice(cursor, end);
      buffer = buffer.slice(end);
      return emit;
    },

    flush(): string {
      const { out, cursor } = redactMatches(buffer, buffer.length);
      const rest = buffer.slice(cursor);
      buffer = "";
      // The stream ended inside what may be a secret: hide that partial prefix too.
      const partial = partialPrefixStart(rest);
      return out + (partial === -1 ? rest : rest.slice(0, partial) + STREAM_REDACTION_PLACEHOLDER);
    },
  };
}
