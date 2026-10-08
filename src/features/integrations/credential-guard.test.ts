import { describe, expect, it } from "vitest";

import { detectCredential } from "./credential-guard";

const fake = (...parts: string[]) => parts.join("");

describe("chat credential guard", () => {
  it.each([
    ["Supabase PAT", fake("sbp", "_", "0123456789abcdefghijklmnopqrstuvwxyz")],
    [
      "Supabase secret key",
      fake("sb", "_secret_", "0123456789abcdefghijklmnopqrstuvwxyz"),
    ],
    [
      "JWT",
      fake(
        "eyJhbGciOiJIUzI1NiJ9",
        ".",
        "eyJyb2xlIjoic2VydmljZV9yb2xlIn0",
        ".",
        "abcdefghijklmnop",
      ),
    ],
    ["bearer token", `Bearer ${fake("secret", "-", "token-1234567890")}`],
    ["password DSN", "postgresql://admin:verysecretpassword@db.example.com/app"],
    ["custom labeled key", "api_key: custom-key-value-123456789"],
    [
      "unlabelled custom MCP key",
      "Connect this MCP using AbCdEfGhIjKlMnOpQrStUvWx12345678",
    ],
  ])("detects a %s", (_label, input) => {
    expect(detectCredential(input).detected).toBe(true);
  });

  it.each([
    "Use process.env.API_KEY in the MCP client.",
    "Read import.meta.env.VITE_API_KEY.",
    "api_key: <your-api-key>",
    "api_key: example",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_0123456789abcdefghijklmnopqrstuvwxyz",
    "Project ref: abcdefghijklmnop",
    "commit 9fceb02d0ae598e95dc970b74767f19372d61af8",
    "id: 550e8400-e29b-41d4-a716-446655440000",
    "https://docs.supabase.com/guides/auth",
    "Connect the MCP endpoint https://mcp.internal-tool.example.com/mcp",
  ])("allows non-secret prompt text: %s", (input) => {
    expect(detectCredential(input)).toEqual({
      detected: false,
      matchedRules: [],
    });
  });

  it("returns rule names without returning the secret", () => {
    const secret = fake("sbp", "_", "0123456789abcdefghijklmnopqrstuvwxyz");
    const result = detectCredential(secret);

    expect(result.matchedRules).toContain("supabase-pat");
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
