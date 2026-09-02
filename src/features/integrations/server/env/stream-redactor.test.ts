import { describe, expect, it } from "vitest";

import {
  STREAM_REDACTION_PLACEHOLDER,
  createStreamRedactor,
} from "./stream-redactor";

/**
 * The sandbox route pipes all install and dev-server output to the browser. Once
 * secrets are injected into that sandbox, anything the process prints can contain
 * them — so this is the last line of defence between an injected secret and the
 * client watching the terminal.
 *
 * The chunk-boundary case is the reason this is stateful rather than a pure
 * function: stream writes split at arbitrary byte offsets.
 */

const SECRET = "sbp_supersecretvalue1234567890";
const DSN = "postgresql://user:hunter2password@db.example.com:5432/app";

/** Feed a whole string through in fixed-size chunks. */
function streamThrough(text: string, chunkSize: number, secrets: string[]) {
  const redactor = createStreamRedactor(secrets);
  let output = "";
  for (let i = 0; i < text.length; i += chunkSize) {
    output += redactor.push(text.slice(i, i + chunkSize));
  }
  return output + redactor.flush();
}

describe("createStreamRedactor", () => {
  it("redacts a secret within a single chunk", () => {
    const redactor = createStreamRedactor([SECRET]);
    const out = redactor.push(`Connecting with ${SECRET}\n`) + redactor.flush();

    expect(out).not.toContain(SECRET);
    expect(out).toContain(STREAM_REDACTION_PLACEHOLDER);
  });

  it("redacts a secret split across two chunks", () => {
    // The case a per-chunk replace would miss entirely.
    const redactor = createStreamRedactor([SECRET]);
    const half = Math.floor(SECRET.length / 2);

    let out = redactor.push(`key=${SECRET.slice(0, half)}`);
    out += redactor.push(`${SECRET.slice(half)} done\n`);
    out += redactor.flush();

    expect(out).not.toContain(SECRET);
    expect(out).toContain(STREAM_REDACTION_PLACEHOLDER);
  });

  it("redacts regardless of chunk size, including one byte at a time", () => {
    const text = `boot\nusing ${SECRET} to connect\nready\n`;

    for (const size of [1, 2, 3, 7, 13, 64, 1024]) {
      const out = streamThrough(text, size, [SECRET]);
      expect(out, `chunk size ${size}`).not.toContain(SECRET);
    }
  });

  it("preserves all non-secret content exactly", () => {
    const text = "npm install\nadded 42 packages\nready on :3000\n";
    expect(streamThrough(text, 5, [SECRET])).toBe(text);
  });

  it("redacts a connection-string password", () => {
    const out = streamThrough(
      `Error: could not connect to ${DSN}\n`,
      9,
      ["hunter2password"],
    );

    expect(out).not.toContain("hunter2password");
    expect(out).toContain("postgresql://user:");
  });

  it("redacts every occurrence", () => {
    const out = streamThrough(`${SECRET} then ${SECRET}\n`, 8, [SECRET]);
    expect(out).not.toContain(SECRET);
    expect(out.split(STREAM_REDACTION_PLACEHOLDER)).toHaveLength(3);
  });

  it("redacts several different secrets", () => {
    const a = "first_secret_value_aaaa";
    const b = "second_secret_value_bbbb";
    const out = streamThrough(`${a} and ${b}\n`, 6, [a, b]);

    expect(out).not.toContain(a);
    expect(out).not.toContain(b);
  });

  it("prefers the longest secret when one contains another", () => {
    const short = "secretvalue";
    const long = "secretvalue_extended_form";
    const out = streamThrough(`v=${long}\n`, 7, [short, long]);

    expect(out).not.toContain(short);
    expect(out).toContain(STREAM_REDACTION_PLACEHOLDER);
  });

  it("handles secrets containing regex metacharacters", () => {
    const secret = "a+b(c)[d]$e.f*g";
    const out = streamThrough(`token=${secret}\n`, 4, [secret]);
    expect(out).not.toContain(secret);
  });

  it("ignores values too short to redact safely", () => {
    // Replacing every 4-character match would make the terminal unreadable while
    // protecting almost nothing.
    const text = "port 3000 ready\n";
    expect(streamThrough(text, 4, ["3000"])).toBe(text);
  });

  it("is a pass-through when there are no secrets", () => {
    const redactor = createStreamRedactor([]);
    expect(redactor.push("anything at all")).toBe("anything at all");
    expect(redactor.flush()).toBe("");
  });

  it("is a pass-through when all secrets are too short", () => {
    const redactor = createStreamRedactor(["abc", "de"]);
    expect(redactor.push("abc de")).toBe("abc de");
  });

  it("releases buffered text on flush", () => {
    // Without flush, the held-back tail would never reach the terminal and the last
    // line of output would silently vanish.
    const redactor = createStreamRedactor([SECRET]);
    const pushed = redactor.push("tail without newline");
    const flushed = redactor.flush();

    expect(pushed + flushed).toBe("tail without newline");
  });

  it("does not hold back a completed line unnecessarily", () => {
    // Output the user is waiting to see should not be delayed behind the hold-back
    // window when a newline already proves no secret spans it.
    const redactor = createStreamRedactor([SECRET]);
    const out = redactor.push("installing dependencies...\n");

    expect(out).toContain("installing dependencies...\n");
  });

  describe("multi-line secrets", () => {
    const PEM =
      "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkq\nhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";

    it("never emits the first line of a multi-line secret", () => {
      // The newline release shortcut has to be disabled when a secret itself spans
      // newlines, or its first line escapes verbatim. This was a real bug found
      // while fixing the short-chunk case.
      const out = streamThrough(`key=${PEM}\nready\n`, 9, [PEM]);

      expect(out).not.toContain("MIIBVgIBADANBgkq");
      expect(out).not.toContain("-----BEGIN PRIVATE KEY-----");
      expect(out).toContain(STREAM_REDACTION_PLACEHOLDER);
    });

    it("redacts a multi-line secret at every chunk size", () => {
      for (const size of [1, 5, 17, 40, 4096]) {
        const out = streamThrough(`v=${PEM}\n`, size, [PEM]);
        expect(out, `chunk size ${size}`).not.toContain("MIIBVgIBADANBgkq");
      }
    });

    it("still passes ordinary output through when a multi-line secret is configured", () => {
      const text = "npm install\nadded 42 packages\nready\n";
      expect(streamThrough(text, 6, [PEM])).toBe(text);
    });
  });

  it("loses nothing across many chunks", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}\n`).join("");
    expect(streamThrough(text, 3, [SECRET])).toBe(text);
  });

  it("handles an empty chunk", () => {
    const redactor = createStreamRedactor([SECRET]);
    expect(() => redactor.push("")).not.toThrow();
  });
});
