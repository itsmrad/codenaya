import { describe, expect, it } from "vitest";
import { inspectImportedProject, isRealEnvFile, parseEnvVarNames } from "./inspect-imported-project";

import { MAX_ENV_KEY_LENGTH, MAX_ENV_VARS } from "@/features/integrations/env-keys";

const file = (path: string, content = "") => ({ path, content });

describe("inspectImportedProject", () => {
  it("detects the dependency marker, including nested packages", () => {
    expect(inspectImportedProject([file("app/package.json", JSON.stringify({ devDependencies: { "lovable-tagger": "1" } }))])).toEqual({ source: "other-builder", envVarNames: [] });
  });
  it("detects the directory marker with or without a directory entry", () => {
    for (const path of [".bolt", ".bolt/config.json"]) {
      expect(inspectImportedProject([file(path)]).source).toBe("other-builder");
    }
  });
  it("leaves unknown sources unset and tolerates invalid package JSON", () => {
    expect(inspectImportedProject([file("package.json", "null"), file("app/package.json", "{")])).toEqual({ envVarNames: [] });
    expect(inspectImportedProject([file("README.md", "lovable-tagger .bolt/")]).source).toBeUndefined();
  });
  it("sorts and caps names deterministically across files", () => {
    const names = Array.from({ length: MAX_ENV_VARS + 2 }, (_, i) => `KEY_${String(i).padStart(3, "0")}`);
    const files = [
      file("src/a.ts", names.slice(0, 251).map((name) => `process.env.${name}`).join(";")),
      file("src/b.ts", names.slice(251).reverse().map((name) => `import.meta.env.${name}`).join(";")),
    ];
    const expected = names.slice(0, MAX_ENV_VARS);
    expect(inspectImportedProject(files).envVarNames).toEqual(expected);
    expect(inspectImportedProject(files.reverse()).envVarNames).toEqual(expected);
    expect(expected).toHaveLength(500);
  });
  it("collapses duplicates across files without retaining values", () => {
    expect(inspectImportedProject([
      file("src/main.ts", "import.meta.env.VITE_SUPABASE_URL; process.env.API_KEY"),
      file(".env.example", "VITE_SUPABASE_URL=example-url\nAPI_KEY=fake-example-value"),
    ]).envVarNames).toEqual(["API_KEY", "VITE_SUPABASE_URL"]);
  });
});

describe("parseEnvVarNames", () => {
  it("extracts both source syntaxes, excluding built-ins and duplicates", () => {
    expect(parseEnvVarNames(file("src/main.tsx", `
      import.meta.env.VITE_SUPABASE_URL; process.env.PRIVATE_KEY;
      import.meta.env.VITE_SUPABASE_URL; import.meta.env.MODE;
      import.meta.env.DEV; import.meta.env.PROD; import.meta.env.BASE_URL;
      import.meta.env.SSR; process.env.NODE_ENV;
    `))).toEqual(["PRIVATE_KEY", "VITE_SUPABASE_URL"]);
  });
  it("reads example and sample assignment names only", () => {
    for (const path of [".env.example", "app/.env.sample"]) {
      expect(parseEnvVarNames(file(path, "# COMMENT=value\n export API_KEY = fake\nVITE_URL=\nBAD-KEY=x\nnot an assignment"))).toEqual(["API_KEY", "VITE_URL"]);
    }
  });
  it("reads explicit names in README environment sections only", () => {
    expect(parseEnvVarNames(file("README.md", "# Setup\n`IGNORE_ME`\n## Environment variables\nSet `API_KEY` and `VITE_URL`.\nDATABASE_URL=fake\n## Other\n`IGNORE_TOO`"))).toEqual(["API_KEY", "DATABASE_URL", "VITE_URL"]);
  });
  it("skips keys over 256 characters but keeps the boundary in every input format", () => {
    const kept = `KEY_${"A".repeat(MAX_ENV_KEY_LENGTH - 4)}`;
    const skipped = `${kept}B`;
    for (const input of [
      file("src/main.ts", `process.env.${kept}; import.meta.env.${skipped}`),
      file(".env.example", `${kept}=fake\n${skipped}=fake`),
      file("README.md", `## Environment variables\n\`${kept}\` and \`${skipped}\``),
    ]) expect(parseEnvVarNames(input)).toEqual([kept]);
    expect(kept).toHaveLength(256);
    expect(skipped).toHaveLength(257);
  });
  it("ignores prose acronyms and short tokens in README environment sections", () => {
    expect(parseEnvVarNames(file("README.md", `## Environment variables
      Use \`API\`, \`URL\`, \`JSON\`, \`HTTP\`, \`README\`, \`TODO\`, \`A_\` and \`FOO\`.
      Set \`API_KEY\`, \`VITE_URL\`, and \`A_B\`.
API=fake
DATABASE_URL=fake
    `))).toEqual(["API_KEY", "A_B", "DATABASE_URL", "VITE_URL"]);
  });
  it("excludes real dotenv files and unrelated files", () => {
    for (const path of [".env", ".env.local", "nested/.env.production", ".env.example.local", "prod.env", ".envrc", ".ENV.LOCAL"]) {
      expect(isRealEnvFile(path)).toBe(true);
      expect(parseEnvVarNames(file(path, "REAL_KEY=fake\nprocess.env.IGNORE_ME"))).toEqual([]);
    }
    expect(parseEnvVarNames(file("notes.txt", "process.env.IGNORE_ME"))).toEqual([]);
  });
});
