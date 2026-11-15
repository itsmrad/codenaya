import { describe, expect, it } from "vitest";

import { isSecretEnvFile } from "./envFiles";

describe("isSecretEnvFile", () => {
  it.each([".env", ".env.local", ".env.production", ".env.development.local", "prod.env", ".envrc", ".ENV", "Prod.ENV"])(
    "hides %s",
    (name) => expect(isSecretEnvFile(name)).toBe(true),
  );

  it.each([".env.example", ".env.sample", ".ENV.EXAMPLE", "env.ts", "environment.ts", "env", ".environment", "dotenv.js", "a.env.example", "README.md"])(
    "keeps %s",
    (name) => expect(isSecretEnvFile(name)).toBe(false),
  );
});
