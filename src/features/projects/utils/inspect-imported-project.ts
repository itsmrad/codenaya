import { MAX_ENV_KEY_LENGTH, MAX_ENV_VARS, isValidEnvKey } from "@/features/integrations/env-keys";

interface ImportedFile { path: string; content: string }

// Marker strings matched in imported files; any match sets source "other-builder".
const BUILDER_MARKERS = [
  { dependency: "lovable-tagger" },
  { directory: ".bolt" },
] as const;
const BUILT_INS = new Set(["MODE", "DEV", "PROD", "BASE_URL", "SSR", "NODE_ENV"]);

/** Only example files may supply env names; never inspect or import real dotenv files. */
export function isRealEnvFile(path: string): boolean {
  const name = path.split("/").at(-1) ?? "";
  return (/^\.env(?:rc)?(?:\.|$)/i.test(name) || /\.env$/i.test(name)) &&
    !/^\.env\.(example|sample)$/i.test(name);
}

export function parseEnvVarNames({ path, content }: ImportedFile): string[] {
  if (isRealEnvFile(path)) return [];
  const names = new Set<string>();
  const add = (key: string) => {
    if (key.length <= MAX_ENV_KEY_LENGTH && isValidEnvKey(key) && !BUILT_INS.has(key)) names.add(key);
  };
  if (/(^|\/)\.env\.(example|sample)$/i.test(path)) {
    for (const match of content.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) add(match[1]);
  } else if (path.startsWith("src/")) {
    for (const match of content.matchAll(/\b(?:import\.meta\.env|process\.env)\.([A-Za-z_][A-Za-z0-9_]*)\b/g)) add(match[1]);
  } else if (/(^|\/)readme(?:\.md)?$/i.test(path)) {
    // Explicit assignments and backticked names in env sections, not arbitrary prose.
    const sections = content.split(/(?=^#{1,6}\s)/m);
    for (const section of sections.filter((text) => /^#{1,6}\s[^\n]*(?:environment|env vars)/i.test(text))) {
      for (const match of section.matchAll(/`([A-Z_][A-Z0-9_]+)`|^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/gm)) {
        const key = match[1] ?? match[2];
        if (key.length >= 3 && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(key)) add(key);
      }
    }
  }
  return [...names].sort();
}

export function inspectImportedProject(files: readonly ImportedFile[]) {
  const dependencies = new Set<string>();
  for (const file of files.filter((file) => /(^|\/)package\.json$/.test(file.path))) {
    try {
      const pkg = JSON.parse(file.content);
      for (const field of [pkg?.dependencies, pkg?.devDependencies]) {
        if (field && typeof field === "object") Object.keys(field).forEach((key) => dependencies.add(key));
      }
    } catch { /* An invalid package.json must not prevent importing the repo. */ }
  }
  const source = BUILDER_MARKERS.some((marker) =>
    "dependency" in marker
      ? dependencies.has(marker.dependency)
      : files.some((file) => file.path === marker.directory || file.path.startsWith(`${marker.directory}/`)),
  ) ? ("other-builder" as const) : undefined;
  const envVarNames = [...new Set(files.flatMap(parseEnvVarNames))].sort().slice(0, MAX_ENV_VARS);
  return { ...(source ? { source } : {}), envVarNames };
}
