import { posix } from "node:path";

/**
 * A tsconfig.json that references a tsconfig.app.json nobody wrote, or an
 * index.html whose entry script doesn't exist, boots into a Vite error overlay
 * (#190). The sandbox checks for them before booting so the user gets the
 * missing file's name instead.
 */

type ProjectFile = { path: string; content: string };

/** tsconfig files are JSONC: drop comments and trailing commas, keep strings intact. */
const parseJsonc = (text: string): unknown => {
  const withoutComments = text.replace(
    /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match, string: string | undefined) => string ?? "",
  );
  try {
    return JSON.parse(withoutComments.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
};

const isLocal = (target: string) => target.startsWith("./") || target.startsWith("../");

/** Paths a tsconfig points at through `extends` and `references`. */
const tsconfigTargets = (tsconfig: ProjectFile, paths: Set<string>): string[] => {
  const config = parseJsonc(tsconfig.content) as {
    extends?: unknown;
    references?: unknown;
  } | null;
  if (!config || typeof config !== "object") return [];

  const dir = posix.dirname(tsconfig.path);
  const resolve = (target: string) => posix.normalize(posix.join(dir, target));

  const extendsList = [config.extends].flat().filter(
    (target): target is string => typeof target === "string" && isLocal(target),
  );
  const references = (Array.isArray(config.references) ? config.references : [])
    .map((reference) => (reference as { path?: unknown })?.path)
    .filter((target): target is string => typeof target === "string")
    .map((target) => {
      const resolved = resolve(target);
      // A reference may name a directory, meaning the tsconfig.json inside it.
      return resolved.endsWith(".json") || paths.has(resolved)
        ? resolved
        : posix.join(resolved, "tsconfig.json");
    });

  return [...extendsList.map(resolve), ...references];
};

/** The local module scripts index.html loads (`/src/main.tsx`). */
const htmlEntryTargets = (html: string): string[] =>
  [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => match[1])
    .filter((src) => !/^(?:[a-z]+:)?\/\//i.test(src))
    .map((src) => posix.normalize(src.replace(/^\//, "").split(/[?#]/)[0]));

/**
 * Describes each file the project's config references but doesn't contain,
 * e.g. `tsconfig.app.json (referenced by tsconfig.json)`.
 */
export const missingReferencedFiles = (files: ProjectFile[]): string[] => {
  const paths = new Set(files.map((file) => file.path));
  const missing: string[] = [];

  for (const file of files) {
    const name = posix.basename(file.path);
    const targets = /^tsconfig[\w.-]*\.json$/.test(name)
      ? tsconfigTargets(file, paths)
      : file.path === "index.html"
        ? htmlEntryTargets(file.content)
        : [];

    for (const target of targets) {
      // Vite also serves public/ at the root.
      if (!paths.has(target) && !paths.has(`public/${target}`)) {
        missing.push(`${target} (referenced by ${file.path})`);
      }
    }
  }

  return missing;
};
