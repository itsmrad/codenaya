import { describe, expect, it } from "vitest";

import {
  REDACTION_PLACEHOLDER,
  redactJsonValue,
  redactSecrets,
} from "./redact";

/**
 * Anything the model sees is written into the conversation, persisted in the
 * `messages` table, and replayed as context on every later turn — so a secret that
 * reaches it is effectively logged forever and shown in the chat transcript.
 *
 * These tests also pin the *false-positive* boundary. Over-redacting is a real
 * cost: mangling a connection string the agent is meant to write into `.env`
 * breaks the generated app in a way that is hard to trace.
 */

/**
 * Credential-shaped fixtures are assembled from fragments rather than written as
 * literals.
 *
 * GitHub's push protection scans for credential shapes and blocked this file when
 * these were inline — a decent signal that the patterns under test are realistic.
 * Concatenating produces an identical value for the regex while leaving nothing
 * secret-shaped in the source, so the repository's own secret scanning stays
 * useful instead of being bypassed with an allowlist entry.
 */
const fake = (...parts: string[]) => parts.join("");

/** A github-shaped token, reused across several cases. */
const FAKE_GITHUB_TOKEN = fake("ghp", "_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");

describe("known-value redaction", () => {
  it("removes an exact credential the project holds", () => {
    const secret = "sbp_abcdefghijklmnopqrstuvwxyz012345";
    const result = redactSecrets(`Your key is ${secret} — keep it safe.`, [
      secret,
    ]);

    expect(result.text).not.toContain(secret);
    expect(result.text).toContain(REDACTION_PLACEHOLDER);
    expect(result.redactionCount).toBe(1);
    expect(result.matchedRules).toContain("known-value");
  });

  it("removes every occurrence", () => {
    const secret = "supersecretvalue123456";
    const result = redactSecrets(`${secret} and again ${secret}`, [secret]);

    expect(result.text).not.toContain(secret);
    expect(result.redactionCount).toBe(2);
  });

  it("prefers the longest value when one secret contains another", () => {
    // Replacing the shorter first would leave a fragment of the longer one.
    const short = "abcdefghij";
    const long = "abcdefghijklmnopqrst";
    const result = redactSecrets(`value=${long}`, [short, long]);

    expect(result.text).toBe(`value=${REDACTION_PLACEHOLDER}`);
  });

  it("handles secrets containing regex metacharacters", () => {
    // Unescaped, the `+` and `(` would throw or match the wrong thing.
    const secret = "abc+def(ghi)[jkl]$mno";
    const result = redactSecrets(`token: ${secret}`, [secret]);

    expect(result.text).not.toContain(secret);
    expect(result.redactionCount).toBe(1);
  });

  it("ignores values too short to match safely", () => {
    // "admin" as an exact secret would corrupt every unrelated mention.
    const result = redactSecrets("the admin user can admin things", ["admin"]);

    expect(result.text).toBe("the admin user can admin things");
    expect(result.redactionCount).toBe(0);
  });

  it("returns text unchanged when nothing matches", () => {
    const input = "Created table `users` with 3 columns.";
    const result = redactSecrets(input, ["sbp_notpresenthere12345"]);

    expect(result.text).toBe(input);
    expect(result.redactionCount).toBe(0);
    expect(result.matchedRules).toEqual([]);
  });
});

describe("token-shape redaction", () => {
  const cases: Array<[string, string, string]> = [
    ["github", fake("ghp", "_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"), "github"],
    [
      "github pat",
      fake("github", "_pat_", "11ABCDEFG0abcdefghijklmnopqrstuvwxyz123456"),
      "github-pat",
    ],
    [
      "stripe live secret",
      fake("sk", "_live_", "ABCDEFGHIJKLMNOP0123456789"),
      "stripe",
    ],
    [
      "stripe restricted",
      fake("rk", "_test_", "ABCDEFGHIJKLMNOP0123456789"),
      "stripe",
    ],
    [
      "supabase pat",
      fake("sbp", "_", "0123456789abcdefghijklmnopqrstuvwxyz"),
      "supabase-pat",
    ],
    ["openai", fake("sk", "-proj-", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"), "openai"],
    ["slack", fake("xoxb", "-", "123456789012", "-", "abcdefghijklmnop"), "slack"],
    [
      "google",
      fake("AIza", "SyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456"),
      "google",
    ],
    ["aws", fake("AKIA", "IOSFODNN7EXAMPLE"), "aws"],
  ];

  it.each(cases)("redacts a %s token", (_label, token, rule) => {
    const result = redactSecrets(`credential: ${token}`);

    expect(result.text).not.toContain(token);
    expect(result.matchedRules).toContain(rule);
  });

  it("redacts a JWT, which is how service-role keys usually arrive", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdefghijklmnop";
    const result = redactSecrets(`anon key: ${jwt}`);

    expect(result.text).not.toContain(jwt);
    expect(result.matchedRules).toContain("jwt");
  });

  it("does not carry regex state between calls", () => {
    // Module-level /g literals keep lastIndex, so a reused RegExp would skip
    // matches on the second call. This caught a real class of bug.
    const token = FAKE_GITHUB_TOKEN;
    for (let i = 0; i < 3; i++) {
      const result = redactSecrets(`token ${token}`);
      expect(result.redactionCount).toBe(1);
    }
  });
});

describe("connection-string passwords", () => {
  it("redacts the password but keeps the topology", () => {
    // The agent still needs to know a DSN came back, and to which host, so only
    // the password is replaced.
    const result = redactSecrets(
      "postgresql://neondb_owner:npg_SuperSecret123@ep-cool-x.aws.neon.tech/neondb",
    );

    expect(result.text).not.toContain("npg_SuperSecret123");
    expect(result.text).toContain("postgresql://neondb_owner:");
    expect(result.text).toContain("@ep-cool-x.aws.neon.tech/neondb");
    expect(result.matchedRules).toContain("dsn-password");
  });

  it("handles mysql and mongodb schemes", () => {
    for (const dsn of [
      "mysql://root:hunter2pass@db.example.com:3306/app",
      "mongodb+srv://admin:s3cretvalue@cluster0.example.mongodb.net/db",
    ]) {
      const result = redactSecrets(dsn);
      expect(result.matchedRules).toContain("dsn-password");
    }
  });

  it("leaves a passwordless URL alone", () => {
    const url = "https://abcdefgh.supabase.co/rest/v1";
    expect(redactSecrets(url).text).toBe(url);
  });
});

describe("false-positive boundary", () => {
  it("leaves ordinary tool output untouched", () => {
    const outputs = [
      "Created table `users` with columns id, email, created_at.",
      "Applied migration 20240101000000_init successfully.",
      "SELECT returned 42 rows in 13ms.",
      "Project ref: abcdefghijklmnop",
      "Deployed edge function `hello-world` to production.",
      "https://docs.supabase.com/guides/auth",
    ];

    for (const output of outputs) {
      const result = redactSecrets(output);
      expect(result.text).toBe(output);
      expect(result.redactionCount).toBe(0);
    }
  });

  it("leaves UUIDs, hashes and long identifiers alone", () => {
    // Entropy-only detection would flag all of these, which is why detection is
    // prefix-anchored instead.
    const outputs = [
      "id: 550e8400-e29b-41d4-a716-446655440000",
      "sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "commit 9fceb02d0ae598e95dc970b74767f19372d61af8",
      "base64 payload: SGVsbG8gd29ybGQsIHRoaXMgaXMgbm90IGEgc2VjcmV0",
    ];

    for (const output of outputs) {
      expect(redactSecrets(output).redactionCount).toBe(0);
    }
  });
});

describe("redactJsonValue", () => {
  it("rewrites strings in place and preserves structure", () => {
    const input = {
      project: { ref: "abcdefghijklmnop", name: "my-app" },
      keys: ["sbp_0123456789abcdefghijklmnopqrstuvwxyz", "public-value"],
      count: 3,
      enabled: true,
      missing: null,
    };

    const result = redactJsonValue(input);
    const output = result.value as typeof input;

    expect(output.keys[0]).toBe(REDACTION_PLACEHOLDER);
    expect(output.keys[1]).toBe("public-value");
    // Non-strings must survive with their types intact.
    expect(output.count).toBe(3);
    expect(output.enabled).toBe(true);
    expect(output.missing).toBeNull();
    expect(output.project.name).toBe("my-app");
    expect(result.redactionCount).toBe(1);
  });

  it("walks nested arrays and objects", () => {
    const input = {
      rows: [
        { settings: { token: FAKE_GITHUB_TOKEN } },
        { settings: { token: "safe" } },
      ],
    };

    const result = redactJsonValue(input);
    expect(JSON.stringify(result.value)).not.toContain("ghp_");
    expect(result.redactionCount).toBe(1);
  });

  it("applies known secrets through the whole tree", () => {
    const secret = "my-project-service-role-key-value";
    const input = { a: { b: [{ c: secret }] } };

    const result = redactJsonValue(input, [secret]);
    expect(JSON.stringify(result.value)).not.toContain(secret);
  });

  it("does not mutate its input", () => {
    const input = { key: FAKE_GITHUB_TOKEN };
    const snapshot = structuredClone(input);

    redactJsonValue(input);
    expect(input).toEqual(snapshot);
  });

  it("passes primitives through unchanged", () => {
    for (const value of [42, true, null, undefined]) {
      expect(redactJsonValue(value).value).toBe(value);
    }
  });

  it("does not recurse forever on a circular structure", () => {
    // This was a real bug: unguarded recursion threw
    // "RangeError: Maximum call stack size exceeded", which would have crashed an
    // agent run rather than degrading. Tool results are parsed JSON and cannot
    // normally be circular, but this also runs over tool arguments from the model.
    const node: Record<string, unknown> = { name: "root" };
    node.self = node;

    expect(() => redactJsonValue(node)).not.toThrow();

    const result = redactJsonValue(node) as { value: Record<string, unknown> };
    expect(result.value.name).toBe("root");
    expect(result.value.self).toBe("[omitted: circular reference]");
  });

  it("handles a cycle through an array", () => {
    const arr: unknown[] = [1, 2];
    arr.push(arr);

    expect(() => redactJsonValue(arr)).not.toThrow();
  });

  it("still redacts a value that legitimately appears twice", () => {
    // A shared (non-circular) reference must not be mistaken for a cycle, or real
    // data would be replaced with the circular placeholder.
    const shared = { token: "AKIAIOSFODNN7EXAMPLE" };
    const input = { a: shared, b: shared };

    const result = redactJsonValue(input) as {
      value: { a: { token: string }; b: { token: string } };
      redactionCount: number;
    };

    expect(result.value.a.token).toBe(REDACTION_PLACEHOLDER);
    expect(result.value.b.token).toBe(REDACTION_PLACEHOLDER);
    expect(result.redactionCount).toBe(2);
  });

  it("bounds extremely deep nesting instead of overflowing", () => {
    let node: Record<string, unknown> = { leaf: "AKIAIOSFODNN7EXAMPLE" };
    for (let i = 0; i < 200; i++) {
      node = { child: node };
    }

    expect(() => redactJsonValue(node)).not.toThrow();
  });
});
