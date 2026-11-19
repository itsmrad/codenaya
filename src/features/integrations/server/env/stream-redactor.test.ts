import { describe, expect, it } from "vitest";

import {
  MAX_REDACTED_BYTES,
  MAX_REDACTED_VALUES,
  REDACTION_UNAVAILABLE_NOTICE,
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
function streamThrough(text: string, chunkSize: number, secrets: string[] | null) {
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

  it("redacts a short value", () => {
    expect(streamThrough("port 3000 ready\n", 4, ["3000"])).toBe(
      `port ${STREAM_REDACTION_PLACEHOLDER} ready\n`,
    );
  });

  it("redacts a 3-character value and its encodings", () => {
    const forms = ["abc", "YWJj", "616263", "616263".toUpperCase()];
    const out = streamThrough(`${forms.join(" ")}\n`, 3, ["abc"]);
    expect(out).toBe(`${Array(forms.length).fill(STREAM_REDACTION_PLACEHOLDER).join(" ")}\n`);
  });

  it("skips 1-2 character and whitespace-only values, and their encodings", () => {
    // "1" is hex 31 and base64 MQ; " " is hex 20 and base64 IA.
    const text = "exit 1 at 31 MQ== MQ  IA== 20 ok\n";
    expect(streamThrough(text, 5, ["1", " ", "ab", "   ", "\n\t"])).toBe(text);
  });

  it("redacts the exact value, surrounding whitespace included, and its trimmed form", () => {
    const value = "  dummy-canary-padded\n";
    expect(streamThrough(`a=${value}b\n`, 4, [value])).toBe(`a=${STREAM_REDACTION_PLACEHOLDER}b\n`);
    expect(streamThrough("a=dummy-canary-padded;\n", 4, [value])).toBe(`a=${STREAM_REDACTION_PLACEHOLDER};\n`);
  });

  describe("encodings", () => {
    // Chosen so base64 has "+", "/" and padding, and percent-encoding differs from the value.
    const VALUE = "dummy?canary>>/ü";
    const bytes = Buffer.from(VALUE, "utf8");
    const base64 = bytes.toString("base64");
    const forms = {
      "base64": base64,
      "base64 without padding": base64.replace(/=+$/, ""),
      "url-safe base64": bytes.toString("base64url"),
      "url-safe base64 with padding": base64.replace(/\+/g, "-").replace(/\//g, "_"),
      "percent-encoding": encodeURIComponent(VALUE),
      "lower-case hex": bytes.toString("hex"),
      "upper-case hex": bytes.toString("hex").toUpperCase(),
    };

    it("covers forms that really differ", () => {
      expect(base64).toMatch(/[+/].*=$/);
      expect(new Set(Object.values(forms)).size).toBe(Object.keys(forms).length);
    });

    it.each(Object.entries(forms))("redacts the %s form", (_name, form) => {
      expect(streamThrough(`v=${form};\n`, 3, [VALUE])).toBe(`v=${STREAM_REDACTION_PLACEHOLDER};\n`);
    });
  });

  describe("overlapping values", () => {
    it("takes the longest value starting at a position, even split across chunks", () => {
      const redactor = createStreamRedactor(["abc", "abcdef"]);
      const out = redactor.push("x abc") + redactor.push("def y") + redactor.flush();
      expect(out).toBe(`x ${STREAM_REDACTION_PLACEHOLDER} y`);
    });

    it("takes a value starting earlier over a shorter one inside it", () => {
      expect(streamThrough("xabcd\n", 1, ["abc", "xabcd"])).toBe(`${STREAM_REDACTION_PLACEHOLDER}\n`);
    });
  });

  it("gives the one-shot result for every way of cutting the stream in two or three", () => {
    const PEM = "-----BEGIN KEY-----\nDUMMYKEYAAAA\n-----END KEY-----";
    const secrets = ["abc", "abcdef", "xabcd", " dummy-pad ", PEM, "dummy-secret-one"];
    const text =
      `boot abcdef xabcde ${Buffer.from("dummy-secret-one").toString("base64")}\n` +
      `key=${PEM} %20dummy-pad end\nabcd`;
    const oneShot = streamThrough(text, text.length, secrets);
    expect(oneShot).not.toMatch(/abc|dummy|DUMMY/);

    for (let i = 0; i <= text.length; i++) {
      for (let j = i; j <= text.length; j++) {
        const redactor = createStreamRedactor(secrets);
        const out =
          redactor.push(text.slice(0, i)) +
          redactor.push(text.slice(i, j)) +
          redactor.push(text.slice(j)) +
          redactor.flush();
        if (out !== oneShot) expect(out, `cut at ${i} and ${j}`).toBe(oneShot);
      }
    }
    expect(streamThrough(text, 1, secrets)).toBe(oneShot);
  });

  it("hides a partial value left at the end of the stream", () => {
    const redactor = createStreamRedactor([SECRET]);
    const out = redactor.push(`done\nkey=${SECRET.slice(0, -3)}`) + redactor.flush();
    expect(out).toBe(`done\nkey=${STREAM_REDACTION_PLACEHOLDER}`);
  });

  it("keeps a 1-2 character tail that only starts a value", () => {
    // SECRET starts "sb": ordinary words ending in "s" must survive.
    expect(streamThrough("added packages", 4, [SECRET])).toBe("added packages");
    expect(streamThrough("added sb", 4, [SECRET])).toBe("added sb");
    expect(streamThrough("added sbp", 4, [SECRET])).toBe(`added ${STREAM_REDACTION_PLACEHOLDER}`);
  });

  describe("failing closed", () => {
    const expectSuppressed = (secrets: string[] | null) => {
      const redactor = createStreamRedactor(secrets);
      expect(redactor.push(`raw ${SECRET}\n`)).toBe(REDACTION_UNAVAILABLE_NOTICE);
      expect(redactor.push("more output\n")).toBe("");
      expect(redactor.flush()).toBe("");
    };

    it("hides the output when the values could not be loaded", () => {
      expectSuppressed(null);
    });

    it("hides the output when the values cannot be encoded", () => {
      // A lone surrogate makes encodeURIComponent throw.
      expectSuppressed([SECRET, "dummy\uD800value"]);
    });

    it("hides the output past the value count cap", () => {
      expectSuppressed(Array.from({ length: MAX_REDACTED_VALUES + 1 }, (_, i) => `dummy-value-${i}`));
    });

    it("hides the output past the byte cap", () => {
      expectSuppressed(["x".repeat(MAX_REDACTED_BYTES + 1)]);
    });

    it("says why once, even when nothing is pushed", () => {
      expect(streamThrough("", 1, null)).toBe(REDACTION_UNAVAILABLE_NOTICE);
    });
  });

  it("is a pass-through when there are no secrets", () => {
    const redactor = createStreamRedactor([]);
    expect(redactor.push("anything at all")).toBe("anything at all");
    expect(redactor.flush()).toBe("");
  });

  it("is a pass-through when all secrets are below the floor", () => {
    const redactor = createStreamRedactor(["ab", "d", "   ", ""]);
    expect(redactor.push("ab d   ")).toBe("ab d   ");
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
