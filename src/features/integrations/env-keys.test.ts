import { describe, expect, it } from "vitest";

import {
  PUBLIC_KEY_PREFIXES,
  assertValidEnvKey,
  classifyEnvKey,
  isPublicByConvention,
  isValidEnvKey,
  maskCredential,
  maskSecret,
} from "./env-keys";

describe("isPublicByConvention", () => {
  it.each(PUBLIC_KEY_PREFIXES)("treats %s-prefixed keys as public", (prefix) => {
    expect(isPublicByConvention(`${prefix}API_URL`)).toBe(true);
  });

  it("does not treat server-only keys as public", () => {
    for (const key of [
      "DATABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "STRIPE_SECRET_KEY",
      "OPENAI_API_KEY",
      "SESSION_SECRET",
    ]) {
      expect(isPublicByConvention(key)).toBe(false);
    }
  });

  it("requires the prefix at the start, not anywhere in the key", () => {
    // A key that merely mentions a public prefix is still a secret.
    expect(isPublicByConvention("MY_NEXT_PUBLIC_KEY")).toBe(false);
    expect(isPublicByConvention("SECRET_VITE_TOKEN")).toBe(false);
  });

  it("is case-sensitive", () => {
    // Bundlers match the exact prefix, so a lowercase variant is not inlined and
    // must not be classified public.
    expect(isPublicByConvention("next_public_url")).toBe(false);
  });
});

describe("classifyEnvKey", () => {
  it("defaults unknown keys to secret", () => {
    // Failing toward secret means an unfamiliar key is withheld from the browser
    // preview. The opposite default would publish it.
    expect(classifyEnvKey("SOME_NEW_THING")).toBe("secret");
    expect(classifyEnvKey("DATABASE_URL")).toBe("secret");
  });

  it("classifies bundler-inlined keys as public", () => {
    expect(classifyEnvKey("NEXT_PUBLIC_SUPABASE_URL")).toBe("public");
    expect(classifyEnvKey("VITE_API_BASE")).toBe("public");
  });
});

describe("isValidEnvKey / assertValidEnvKey", () => {
  it("accepts conventional names", () => {
    for (const key of ["A", "_PRIVATE", "DATABASE_URL", "PORT2", "a_b_c"]) {
      expect(isValidEnvKey(key)).toBe(true);
      expect(() => assertValidEnvKey(key)).not.toThrow();
    }
  });

  it("rejects names that a shell or dotenv parser would mangle", () => {
    for (const key of [
      "",
      "1PORT",
      "MY-KEY",
      "MY KEY",
      "MY.KEY",
      "KEY=VALUE",
      "KEY\nINJECTED",
      "KEY$SUB",
      'KEY"QUOTE',
    ]) {
      expect(isValidEnvKey(key)).toBe(false);
      expect(() => assertValidEnvKey(key)).toThrow(/not a valid environment/);
    }
  });

  it("rejects newline injection specifically", () => {
    // A key containing a newline could inject an extra assignment when written
    // into a .env file.
    expect(isValidEnvKey("GOOD\nEVIL=1")).toBe(false);
  });
});

describe("maskSecret", () => {
  it("fully hides short values", () => {
    for (const value of ["", "a", "abc123", "12345678"]) {
      expect(maskSecret(value)).toBe("••••••••");
    }
  });

  it("reveals only the last four characters of longer values", () => {
    expect(maskSecret("supersecretvalue")).toBe("••••alue");
  });

  it("never contains the full value", () => {
    const secret = "postgres://user:pw@host:5432/db";
    const masked = maskSecret(secret);
    expect(masked).not.toContain("user");
    expect(masked).not.toContain("pw");
    expect(masked.length).toBeLessThan(secret.length);
  });
});

describe("maskCredential", () => {
  it("keeps a recognisable provider prefix", () => {
    // The prefix is how a user tells two credentials apart in a list.
    expect(maskCredential("sbp_1234567890abcdef")).toBe("sbp_••••cdef");
    expect(maskCredential("rk_live_abcdefghijklmn")).toBe("rk_live_••••klmn");
  });

  it("hides short values entirely", () => {
    expect(maskCredential("abc")).toBe("••••••••");
    expect(maskCredential("sbp_1234")).toBe("••••••••");
  });

  it("falls back to plain masking when there is no usable prefix", () => {
    expect(maskCredential("aVeryLongTokenWithNoUnderscores")).toBe("••••ores");
  });

  it("does not treat a long leading segment as a prefix", () => {
    // Guards against echoing most of a token that happens to contain a late
    // underscore.
    const masked = maskCredential("averylongsecretsegment_tail1234");
    expect(masked).toBe("••••1234");
  });

  it("never leaks the middle of a credential", () => {
    const token = "github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const masked = maskCredential(token);
    expect(masked).not.toContain("MNOPQRST");
    expect(masked.startsWith("github_pat_")).toBe(true);
  });

  it("trims surrounding whitespace before masking", () => {
    expect(maskCredential("  sbp_1234567890abcdef  ")).toBe("sbp_••••cdef");
  });
});
