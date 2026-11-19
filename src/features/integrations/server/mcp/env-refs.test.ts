import { describe, expect, it } from "vitest";

import { createEnvRefMinter, envRefVisibility, newEnvRefId } from "./env-refs";
import { REDACTION_PLACEHOLDER, redactJsonValue } from "./redact";

// Assembled from fragments so nothing secret-shaped sits in the source (see redact.test.ts).
const fake = (...parts: string[]) => parts.join("");
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims: object) => [b64({ alg: "HS256", typ: "JWT" }), b64(claims), "signaturesignature"].join(".");

const SUPABASE_URL = "https://abcdefghijklmnopqrst.supabase.co";
const PUBLISHABLE = fake("sb", "_publishable_", "0123456789abcdefghij");
const SECRET_KEY = fake("sb", "_secret_", "CANARY_SECRET_123_padding");

describe("envRefVisibility", () => {
  it("makes only the allowlisted public config public", () => {
    expect(envRefVisibility(SUPABASE_URL, "supabase-url")).toBe("public");
    expect(envRefVisibility(PUBLISHABLE, "supabase-publishable")).toBe("public");
    expect(envRefVisibility(jwt({ iss: "supabase", ref: "abc", role: "anon" }), "jwt")).toBe("public");
  });

  it.each([
    ["no role claim", jwt({ sub: "user_1", iss: "auth0" })],
    ["service_role", jwt({ iss: "supabase", role: "service_role" })],
    ["anon from another issuer", jwt({ iss: "example", role: "anon" })],
    ["malformed", "eyJnotajwt.eyJnotajwt.signature"],
  ])("keeps a JWT with %s secret", (_label, value) => {
    expect(envRefVisibility(value, "jwt")).toBe("secret");
  });

  it("keeps everything else secret", () => {
    expect(envRefVisibility(SECRET_KEY, "supabase-secret")).toBe("secret");
    expect(envRefVisibility("hunter2hunter2", "dsn-password")).toBe("secret");
    expect(envRefVisibility(SUPABASE_URL, "unknown-rule")).toBe("secret");
  });
});

describe("ref ids", () => {
  it("are 128 random bits in hex, and never repeat", () => {
    const ids = Array.from({ length: 1000 }, newEnvRefId);
    for (const id of ids) expect(id).toMatch(/^ref_[0-9a-f]{32}$/);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("redaction with a minter", () => {
  it("replaces secrets and Supabase config with refs, reusing one ref per value", () => {
    const { toRef, refs } = createEnvRefMinter();
    const result = redactJsonValue(
      { url: SUPABASE_URL, keys: [PUBLISHABLE, SECRET_KEY, SECRET_KEY] },
      [],
      toRef,
    );
    const text = JSON.stringify(result.value);

    expect(text).not.toContain("CANARY_SECRET_123");
    expect(text).not.toContain(SUPABASE_URL);
    expect(text).not.toContain(PUBLISHABLE);
    expect(refs.map(({ rule, visibility }) => [rule, visibility])).toEqual([
      ["supabase-url", "public"],
      ["supabase-publishable", "public"],
      ["supabase-secret", "secret"],
    ]);
    for (const ref of refs) expect(text).toContain(`[env-ref:${ref.refId} ${ref.visibility}]`);
    // The secret appears twice under one ref.
    expect(text.split(refs[2].refId)).toHaveLength(3);
  });

  it("never refs a known value (the MCP credential, stored secrets)", () => {
    const { toRef, refs } = createEnvRefMinter();
    const known = "known-credential-value";
    const result = redactJsonValue(`token ${known}`, [known], toRef);

    expect(result.value).toBe(`token ${REDACTION_PLACEHOLDER}`);
    expect(refs).toEqual([]);
  });

  it("refs only a DSN's password", () => {
    const { toRef, refs } = createEnvRefMinter();
    const result = redactJsonValue("postgres://app:pa55word-xyz@db.example.com/app", [], toRef);

    expect(result.value).toBe(`postgres://app:[env-ref:${refs[0].refId} secret]@db.example.com/app`);
    expect(refs[0]).toMatchObject({ value: "pa55word-xyz", rule: "dsn-password" });
  });

  it("never refs a DSN password that was already redacted as a known value", () => {
    const { toRef, refs } = createEnvRefMinter();
    const result = redactJsonValue("postgres://app:known-pa55word-xyz@db.example.com/app", ["known-pa55word-xyz"], toRef);

    expect(result.value).toBe(`postgres://app:${REDACTION_PLACEHOLDER}@db.example.com/app`);
    expect(refs).toHaveLength(0);
  });

  it("leaves Supabase config visible where no refs are minted", () => {
    expect(redactJsonValue(SUPABASE_URL).value).toBe(SUPABASE_URL);
  });
});
