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

/**
 * Shortest value, and shortest trailing partial value, that is redacted. Shorter
 * ones have near-zero entropy, and redacting them would destroy unrelated output.
 */
export const MIN_REDACTED_LENGTH = 3;

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
  // The characters that encode only the value's bytes when it sits at each byte
  // alignment inside a longer base64 string, as in Basic auth (`user:value`).
  const embedded = [0, 1, 2].map((offset) =>
    Buffer.concat([Buffer.alloc(offset), bytes])
      .toString("base64")
      .slice(Math.ceil((8 * offset) / 6), Math.floor((8 * (offset + bytes.length)) / 6)),
  )
    // A 3-character fragment turns up inside ordinary words ("key" yields "tle").
    .filter((part) => part.length >= 4);
  return [
    value,
    base64,
    base64.replace(/=+$/, ""),
    base64Url,
    base64Url.padEnd(base64.length, "="),
    ...embedded,
    ...embedded.map((part) => part.replace(/\+/g, "-").replace(/\//g, "_")),
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
    .filter((value) => value.length >= MIN_REDACTED_LENGTH && value.trim() !== "");
  // Longest first, so the regex alternation takes the longest match at a position.
  const known = [...new Set(values.flatMap(encodingsOf))]
    .filter((form) => form.length >= MIN_REDACTED_LENGTH)
    .sort((a, b) => b.length - a.length);
  const pattern = new RegExp(known.map(escapeRegExp).join("|"), "g");
  // V8 compiles lazily: surface "Regular expression too large" (whose message
  // quotes every value) here, inside the caller's try, not at the first exec.
  pattern.test("");
  return { known, pattern };
}

/** Logs a redaction failure by the error's name only: its message could quote a value. */
function logFailure(what: string, error: unknown) {
  console.error(`[stream-redactor] ${what}`, error instanceof Error ? error.name : typeof error);
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
 * Redact one whole text, not a stream. Pass only the variable part (command
 * output, an error message, file content), never a fixed prefix the caller or a
 * reader checks with `startsWith`: a short value could occur in it. `null`
 * (values unknown) hides the text behind the notice.
 */
export function redact(text: string, secrets: readonly string[] | null): string {
  const redactor = createStreamRedactor(secrets);
  return redactor.push(text) + redactor.flush();
}

/**
 * Create a redactor for a fixed set of secret values.
 *
 * Pass `null` when the values could not be loaded: the redactor then fails closed
 * and suppresses the output, as it does when the inventory exceeds its bounds or
 * matching fails. Never throws. Returns a pass-through when there is nothing to
 * redact, so a project with no secrets pays no per-chunk cost.
 */
export function createStreamRedactor(
  secrets: readonly string[] | null,
): StreamRedactor {
  let matcher: ReturnType<typeof matcherOrNull> = null;
  try {
    matcher = secrets === null ? null : matcherOrNull(secrets);
  } catch (error) {
    logFailure("could not build the redaction patterns", error);
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
   * How far a completed line must still be held back.
   *
   * A pattern with no newline, or one only at its end, cannot span the last
   * newline, so the text up to it is decided and released at once — which keeps
   * the terminal responsive. Only a raw multi-line value (a PEM key; encodings
   * never hold a newline) can, so its length minus one stays held.
   */
  const multiLineHold =
    Math.max(1, ...known.filter((value) => value.slice(0, -1).includes("\n")).map((value) => value.length)) - 1;

  /** Raw, not-yet-emitted input. Never holds placeholder text. */
  let buffer = "";
  /** How many leading characters of `buffer` an emitted placeholder already covers. */
  let masked = 0;

  /**
   * Mask every occurrence of every pattern that starts before `decided` — where
   * none can reach past the input seen so far — one placeholder per run of
   * overlapping occurrences, so a shorter match cannot leave a longer value's
   * tail raw. Emits the text up to `decided` and keeps the rest buffered.
   */
  const release = (decided: number, atEnd: boolean): string => {
    // The stream ended inside what may be a secret: that partial prefix is masked too.
    const partial = atEnd ? partialPrefixStart(buffer) : -1;
    const matchesBefore = partial === -1 ? decided : partial;
    let out = "";
    let at = masked; // text before `at` is emitted or masked
    pattern.lastIndex = 0;
    for (let match = pattern.exec(buffer); match && match.index < matchesBefore; match = pattern.exec(buffer)) {
      if (match.index >= at) out += buffer.slice(at, match.index) + STREAM_REDACTION_PLACEHOLDER;
      at = Math.max(at, match.index + match[0].length);
      pattern.lastIndex = match.index + 1;
    }
    if (partial !== -1) {
      if (partial >= at) out += buffer.slice(at, partial) + STREAM_REDACTION_PLACEHOLDER;
      at = buffer.length;
    }
    out += buffer.slice(at, decided);
    masked = Math.max(0, at - decided);
    buffer = buffer.slice(decided);
    return out;
  };

  /** Where the earliest trailing partial prefix of a pattern starts, or -1 when the text ends clear of one. */
  const partialPrefixStart = (text: string): number => {
    for (let i = Math.max(0, text.length - holdBack); i <= text.length - MIN_REDACTED_LENGTH; i++) {
      const tail = text.slice(i);
      if (known.some((value) => value.startsWith(tail))) return i;
    }
    return -1;
  };

  /** A failure while matching hides the rest of the stream rather than throwing. */
  const hidden = suppressingRedactor();
  let failed = false;
  const guarded = (run: () => string): string => {
    if (!failed) {
      try {
        return run();
      } catch (error) {
        logFailure("redaction failed; hiding the rest of the output", error);
        failed = true;
        buffer = "";
      }
    }
    return hidden.push("");
  };

  return {
    push: (chunk) =>
      guarded(() => {
        buffer += chunk;
        const byLength = buffer.length - holdBack;
        const byNewline = Math.min(buffer.lastIndexOf("\n") + 1, buffer.length - multiLineHold);
        return release(Math.max(0, byLength, byNewline), false);
      }),
    flush: () =>
      guarded(() => {
        const out = release(buffer.length, true);
        masked = 0;
        return out;
      }),
  };
}
