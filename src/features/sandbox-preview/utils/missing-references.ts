import { builtinModules } from "node:module";
import { posix } from "node:path";

/**
 * A tsconfig.json that references a tsconfig.app.json nobody wrote, an
 * index.html whose entry script doesn't exist, or a tailwind.config.ts that
 * imports a package missing from package.json, boots into a Vite error
 * overlay (#190). The sandbox checks for them before booting so the user gets
 * the missing file's or package's name instead.
 */

type ProjectFile = { path: string; content: string };

/** Drops line and block comments, leaving string literals (which may contain them) intact. */
const stripComments = (text: string) =>
  text.replace(
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match, string: string | undefined) => string ?? "",
  );

/** tsconfig files are JSONC: drop comments and trailing commas. */
const parseJsonc = (text: string): unknown => {
  try {
    return JSON.parse(stripComments(text).replace(/,(\s*[}\]])/g, "$1"));
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

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]([^"'`\n]+)["'`]/g;
const BUILTINS = new Set(builtinModules);

/** `react-dom/client` → `react-dom`, `@radix-ui/react-slot/x` → `@radix-ui/react-slot`. */
const packageName = (specifier: string): string | null => {
  // Relative and absolute paths, the "@/" and "~/" aliases, URLs and virtual modules.
  if (/^(?:\.|\/|@\/|~|#|[a-z]+:)/i.test(specifier)) return null;
  const parts = specifier.split("?")[0].split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  return BUILTINS.has(name) ? null : name;
};

/**
 * Describes each package the project's code imports but its package.json
 * doesn't declare, e.g. `tailwindcss-animate (imported by tailwind.config.ts)`.
 */
export const undeclaredPackages = (files: ProjectFile[]): string[] => {
  const manifest = files.find((file) => file.path === "package.json");
  const pkg = manifest ? (parseJsonc(manifest.content) as Record<string, unknown> | null) : null;
  if (!pkg || typeof pkg !== "object") return [];

  const declared = new Set(
    ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap(
      (field) => Object.keys((pkg[field] as Record<string, string> | undefined) ?? {}),
    ),
  );
  // Workspace packages declare their own dependencies.
  const nestedPackages = files
    .filter((file) => file.path.endsWith("/package.json"))
    .map((file) => file.path.slice(0, -"package.json".length));
  const undeclared = new Map<string, string>();

  for (const file of files) {
    if (!SOURCE_FILE.test(file.path) || file.path.endsWith(".d.ts")) continue;
    if (nestedPackages.some((dir) => file.path.startsWith(dir))) continue;
    for (const [, specifier] of stripComments(file.content).matchAll(IMPORT_SPECIFIER)) {
      const name = packageName(specifier);
      if (name && !declared.has(name) && !undeclared.has(name)) {
        undeclared.set(name, file.path);
      }
    }
  }

  return [...undeclared].map(([name, path]) => `${name} (imported by ${path})`);
};
