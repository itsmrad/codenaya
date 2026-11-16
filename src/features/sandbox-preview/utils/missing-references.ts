import { builtinModules } from "node:module";
import { posix } from "node:path";

/**
 * A tsconfig.json that references a tsconfig.app.json nobody wrote, an
 * index.html whose entry script doesn't exist, or a vite.config.ts that
 * imports a package missing from package.json, boots into a Vite error
 * overlay (#190). The sandbox checks for them before booting so the user gets
 * the missing file's or package's name instead.
 */

type ProjectFile = { path: string; content: string };

/** Drops line and block comments, leaving string literals (which may contain them) intact. */
export const stripComments = (text: string) =>
  text.replace(
    /("(?:\\.|[^"\\\n\r])*"|'(?:\\.|[^'\\\n\r])*'|`(?:\\.|[^`\\])*`)|(?<!:)\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
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
// `from` counts only after an import/export clause, not in UI copy like "Open from" (#858).
const IMPORT_SPECIFIER =
  /(?:\b(?:import|export)\b[^;"'`]*?\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]([^"'`\n]+)["'`]/g;
// Tailwind v4 CSS pulls packages in too: `@import "tw-animate-css"`, `@plugin "@tailwindcss/typography"`.
const CSS_IMPORT = /@(?:import|plugin)\s+(?:url\(\s*)?["']([^"'\n]+)["']/g;
const BUILTINS = new Set(builtinModules);
// npm's name rules (legacy names may have capitals).
const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

/** `react-dom/client` → `react-dom`, `@radix-ui/react-slot/x` → `@radix-ui/react-slot`. */
const packageName = (specifier: string): string | null => {
  // Relative and absolute paths, the "@/" and "~/" aliases, URLs and virtual modules.
  if (/^(?:\.|\/|@\/|~|#|[a-z]+:)/i.test(specifier)) return null;
  const parts = specifier.split("?")[0].split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  // UI copy like `"Open from" : "Closed"` also looks like an import: skip what no package could be named (#858).
  return BUILTINS.has(name) || !NPM_NAME.test(name) ? null : name;
};

/**
 * Describes each package the project's code or CSS imports but its package.json
 * doesn't declare, e.g. `@tailwindcss/vite (imported by vite.config.ts)`.
 */
export const undeclaredPackages = (
  files: ProjectFile[],
  // All project paths, so a CSS import of an untouched sibling file isn't read as a package.
  paths: Set<string> = new Set(files.map((file) => file.path)),
): string[] => {
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
    if (nestedPackages.some((dir) => file.path.startsWith(dir))) continue;
    // Vite serves public/ as-is, so its CSS imports are never resolved as packages.
    const isCss = file.path.endsWith(".css") && !file.path.startsWith("public/");
    if (!isCss && (!SOURCE_FILE.test(file.path) || file.path.endsWith(".d.ts"))) continue;
    for (const [, specifier] of stripComments(file.content).matchAll(
      isCss ? CSS_IMPORT : IMPORT_SPECIFIER,
    )) {
      // CSS resolves `@import "theme.css"` relative to the file before trying a package.
      if (isCss && paths.has(posix.join(posix.dirname(file.path), specifier))) continue;
      const name = packageName(specifier);
      if (name && !declared.has(name) && !undeclared.has(name)) {
        undeclared.set(name, file.path);
      }
    }
  }

  return [...undeclared].map(([name, path]) => `${name} (imported by ${path})`);
};

export const RESOLVE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
];

/**
 * Project paths a local specifier may name: relative, or `@/` for `src/` (or
 * the root). A `.js` specifier may name its TypeScript source, as in Vite and
 * TypeScript's bundler resolution. Null for anything else, including
 * template-literal and glob imports, which name no single file.
 */
export const localCandidates = (from: string, specifier: string): string[] | null => {
  const bare = specifier.split(/[?#]/)[0];
  if (/\$\{|\*/.test(bare)) return null;
  const targets = isLocal(bare)
    ? [posix.normalize(posix.join(posix.dirname(from), bare))]
    : bare.startsWith("@/")
      ? [`src/${bare.slice(2)}`, bare.slice(2)]
      : null;
  return targets?.flatMap((target) => {
    const ts = target.replace(/\.([cm]?)js(x?)$/, ".$1ts$2");
    return ts === target ? [target] : [target, ts];
  }) ?? null;
};

/**
 * Describes each relative or `@/` import that resolves to no project file,
 * e.g. `./components/Header (imported by src/App.tsx)`. `paths` may include
 * files whose content isn't in `files`, such as uploaded images.
 */
export const unresolvedImports = (
  files: ProjectFile[],
  paths: Set<string> = new Set(files.map((file) => file.path)),
): string[] => {
  const unresolved: string[] = [];

  for (const file of files) {
    if (!SOURCE_FILE.test(file.path) || file.path.endsWith(".d.ts")) continue;
    for (const [, specifier] of stripComments(file.content).matchAll(IMPORT_SPECIFIER)) {
      const candidates = localCandidates(file.path, specifier);
      // The TanStack router plugin writes routeTree.gen.ts on the first dev or build run.
      if (!candidates || /(?:^|\/)routeTree\.gen(?:\.[jt]s)?$/.test(candidates[0])) continue;
      const found = candidates.some((candidate) =>
        RESOLVE_SUFFIXES.some((suffix) => paths.has(candidate + suffix)),
      );
      if (!found) unresolved.push(`${specifier} (imported by ${file.path})`);
    }
  }

  return [...new Set(unresolved)];
};

// Routers we can't read statically: when present, report nothing rather than guess.
// shortcut: skip basename routers until their link prefixes can be resolved reliably.
const OPAQUE_ROUTER =
  /\b(?:createBrowserRouter|createHashRouter|createMemoryRouter|createRoutesFromElements|RouterProvider|useRoutes)\b|@tanstack\/react-router|from\s*["']wouter|<(?:BrowserRouter|HashRouter|MemoryRouter)\b[^>]*\bbasename\s*=/;
const LINK_TAG = /<(?:Link|NavLink|Navigate|a)\b[^>]*?\b(?:to|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*["']([^"'`$]*)["']\s*\})/g;
const NAVIGATE_CALL = /\bnavigate\(\s*["']([^"'`$]+)["']/g;

/** Splits a path into segments, ignoring slashes at the ends. */
const segmentsOf = (path: string) => path.split("/").filter(Boolean);

/** Whether `segments` is served by route `pattern`: params match one segment, `*` the rest. */
const routeMatches = (pattern: string, segments: string[]) => {
  const parts = segmentsOf(pattern);
  const fits = (from: number) => {
    for (const [i, part] of parts.entries()) {
      if (part === "*") return true;
      const segment = segments[from + i];
      if (segment === undefined || (!part.startsWith(":") && part.toLowerCase() !== segment.toLowerCase())) return false;
    }
    return from + parts.length === segments.length;
  };
  // A relative pattern is nested under a parent route we don't resolve: match any tail.
  return pattern.startsWith("/")
    ? fits(0)
    : segments.some((_, from) => fits(from));
};

/**
 * Describes each internal link to a static path no `<Route path>` serves, e.g.
 * `Link to /privacy has no route: add a page or remove the link (in src/Footer.tsx)`.
 * Conservative: reports nothing unless the routes are plain react-router JSX
 * with literal paths, since a false report sends the agent into a pointless repair.
 */
export const linksWithoutRoutes = (
  files: ProjectFile[],
  paths: Set<string> = new Set(files.map((file) => file.path)),
): string[] => {
  const sources = files
    .filter((file) => file.path.startsWith("src/") && SOURCE_FILE.test(file.path) && !file.path.endsWith(".d.ts"))
    .map((file) => ({ path: file.path, text: stripComments(file.content) }));
  if (sources.some(({ text }) => OPAQUE_ROUTER.test(text))) return [];

  const routes: string[] = [];
  for (const { text } of sources) {
    const tags = text.split(/<Route\b/).slice(1);
    for (const tag of tags) {
      const attr = tag.slice(0, 400).match(/\bpath\s*=\s*(?:"([^"]*)"|'([^']*)'|(\{))/);
      if (!attr) continue;
      const path = attr[1] ?? attr[2];
      // Dynamic or optional paths can't be matched reliably.
      if (path === undefined || /[?(]/.test(path)) return [];
      routes.push(path);
    }
  }
  if (routes.length === 0 || routes.some((path) => path === "*" || path === "/*")) return [];

  const publicPaths = [...paths].filter((path) => path.startsWith("public/"));
  const missing = new Map<string, string>();
  for (const { path: file, text } of sources) {
    for (const match of [...text.matchAll(LINK_TAG), ...text.matchAll(NAVIGATE_CALL)]) {
      const target = (match[1] ?? match[2] ?? match[3] ?? "").split(/[?#]/)[0];
      if (!target.startsWith("/") || target.startsWith("//") || /[${}]/.test(target)) continue;
      const segments = segmentsOf(target);
      // The root, API/serverless endpoints and public assets are not pages.
      if (segments.length === 0 || segments[0] === "api" || segments.some((part) => part.startsWith(".")) || /\.\w+$/.test(segments.at(-1)!)) continue;
      const publicTarget = `public/${segments.join("/")}`;
      if (publicPaths.some((path) => path === publicTarget || path.startsWith(`${publicTarget}/`))) continue;
      if (!routes.some((route) => routeMatches(route, segments)) && !missing.has(target)) {
        missing.set(target, file);
      }
    }
  }

  return [...missing].map(
    ([target, file]) => `Link to ${target} has no route: add a page or remove the link (in ${file})`,
  );
};
