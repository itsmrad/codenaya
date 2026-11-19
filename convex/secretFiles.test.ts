import { describe, expect, it } from "vitest";

import { isSecretFile, isSecretPath } from "./secretFiles";

describe("isSecretFile", () => {
  it.each([
    // dotenv
    ".env", ".env.local", ".env.production", ".env.development.local", "prod.env", ".envrc", ".ENV", "Prod.ENV",
    // keys and certificates; public halves too (`id_rsa*`)
    "server.pem", "tls.KEY", "id_rsa", "id_rsa.pub", "id_ed25519", "id_ed25519.pub",
    "id_ecdsa", "id_ecdsa.pub", "id_dsa", "ID_DSA", "client.p12", "cert.PFX", "release.jks", "debug.keystore", "Upload.KeyStore",
    // package-registry and login credentials
    ".npmrc", ".pypirc", ".netrc", ".NPMRC", ".git-credentials", ".pgpass", ".PGPASS",
    // cloud credentials
    "credentials", "Credentials", "credentials.json", "credentials-prod.json", "gcp-service-account.json", "my_service-account_key.json", "Service-Account.JSON",
  ])("hides %s", (name) => expect(isSecretFile(name)).toBe(true));

  it.each([
    ".env.example", ".env.sample", ".ENV.EXAMPLE", "env.ts", "environment.ts", "env", ".environment", "dotenv.js",
    "a.env.example", "README.md", "key.ts", "monkey.json", "keys.ts", "api-key.md", "pem.ts", "npmrc.md",
    "credentials.ts", "service-account.md", "my_id_rsa_notes.txt",
    "my_id_ecdsa_notes.txt", "p12.ts", "keystore.ts", "pfx.md", "git-credentials.md", "pgpass.txt", "my-credentials",
  ])("keeps %s", (name) => expect(isSecretFile(name)).toBe(false));
});

describe("isSecretPath", () => {
  it.each([
    ".env", ".ENV", "./.env", "a/../.env", "sub/.env.local", ".env.production", ".env.template", "sub\\.env.local",
    "sub//.env", "/.env", ".env ", ".env.", ".env. .", " .env", "sub/./.env", "keys/server.pem",
  ])("protects %j", (path) => expect(isSecretPath(path)).toBe(true));

  it.each([".env.example", "sub/.env.sample", "src/env.ts", ".env/..", "src/App.tsx", "credentials/index.ts"])(
    "allows %j",
    (path) => expect(isSecretPath(path)).toBe(false),
  );
});
