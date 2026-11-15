import { describe, expect, it } from "vitest";

import { isSecretFile } from "./secretFiles";

describe("isSecretFile", () => {
  it.each([
    // dotenv
    ".env", ".env.local", ".env.production", ".env.development.local", "prod.env", ".envrc", ".ENV", "Prod.ENV",
    // keys and certificates; public halves too (`id_rsa*`)
    "server.pem", "tls.KEY", "id_rsa", "id_rsa.pub", "id_ed25519", "id_ed25519.pub",
    // package-registry and login credentials
    ".npmrc", ".pypirc", ".netrc", ".NPMRC",
    // cloud credentials
    "credentials.json", "credentials-prod.json", "gcp-service-account.json", "my_service-account_key.json", "Service-Account.JSON",
  ])("hides %s", (name) => expect(isSecretFile(name)).toBe(true));

  it.each([
    ".env.example", ".env.sample", ".ENV.EXAMPLE", "env.ts", "environment.ts", "env", ".environment", "dotenv.js",
    "a.env.example", "README.md", "key.ts", "monkey.json", "keys.ts", "api-key.md", "pem.ts", "npmrc.md",
    "credentials.ts", "service-account.md", "my_id_rsa_notes.txt",
  ])("keeps %s", (name) => expect(isSecretFile(name)).toBe(false));
});
