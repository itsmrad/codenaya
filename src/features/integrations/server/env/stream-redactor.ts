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
 * ## Why a stateful redactor rather than a pure function
 *
 * Stream chunks are arbitrary byte boundaries. A secret can be split across two
 * writes — `"...postgres://user:pa"` then `"ssword@host..."` — and a per-chunk
 * replace would miss it. This holds back a tail of each chunk long enough to catch
 * a secret spanning the boundary, then releases it.
 */

/** Replaces a redacted span, matching the MCP redaction placeholder. */
export const STREAM_REDACTION_PLACEHOLDER = "[redacted]";

/**
 * Values shorter than this are not redacted from the stream.
 *
 * A short value collides with ordinary log text, and replacing every occurrence of
 * a 4-character secret would make the terminal unreadable while protecting little.
 */
const MIN_REDACTABLE_LENGTH = 8;

export interface StreamRedactor {
  /** Redact a chunk, holding back any partial-match tail. */
  push(chunk: string): string;
  /** Release whatever is buffered. Call when the stream ends. */
  flush(): string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Create a redactor for a fixed set of secret values.
 *
 * Returns a pass-through when there is nothing to redact, so a project with no
 * secrets pays no per-chunk cost.
 */
export function createStreamRedactor(
  secrets: readonly string[],
): StreamRedactor {
  const values = [...new Set(secrets)]
    .map((value) => value.trim())
    .filter((value) => value.length >= MIN_REDACTABLE_LENGTH)
    // Longest first, so a secret containing a shorter one is replaced whole.
    .sort((a, b) => b.length - a.length);

  if (values.length === 0) {
    return {
      push: (chunk) => chunk,
      flush: () => "",
    };
  }

  const pattern = new RegExp(values.map(escapeRegExp).join("|"), "g");

  // Enough to cover the longest secret minus one character — the most that can be
  // pending without already being a complete match.
  const holdBack = Math.max(...values.map((v) => v.length)) - 1;

  /**
   * Whether releasing text up to the last newline is safe.
   *
   * Normally a secret cannot span a newline, so a completed line can be emitted
   * immediately instead of waiting behind the hold-back window — which keeps the
   * terminal responsive.
   *
   * But a multi-line secret (a PEM private key, a certificate) *does* contain
   * newlines, and releasing at a newline inside one would emit its first line
   * verbatim. When any secret is multi-line the shortcut is disabled entirely and
   * only the length window applies.
   */
  const newlineReleaseSafe = !values.some((value) => value.includes("\n"));

  let buffer = "";

  return {
    push(chunk: string): string {
      buffer += chunk;

      const redacted = buffer.replace(pattern, STREAM_REDACTION_PLACEHOLDER);

      // Everything beyond the trailing hold-back window is safe to emit.
      const safeByLength = Math.max(0, redacted.length - holdBack);

      // A completed line is also safe, when no secret can span one.
      const safeByNewline = newlineReleaseSafe
        ? redacted.lastIndexOf("\n") + 1
        : 0;

      const emitUpTo = Math.max(safeByLength, safeByNewline);

      const emit = redacted.slice(0, emitUpTo);
      buffer = redacted.slice(emitUpTo);
      return emit;
    },

    flush(): string {
      const remaining = buffer.replace(pattern, STREAM_REDACTION_PLACEHOLDER);
      buffer = "";
      return remaining;
    },
  };
}
