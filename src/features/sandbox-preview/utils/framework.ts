export type Framework = "vite" | "next" | "tanstack-start";

type PackageJson = { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };

const hasDep = (pkg: PackageJson | null | undefined, name: string) =>
  !!(pkg?.dependencies?.[name] ?? pkg?.devDependencies?.[name]);

/**
 * The framework a project is built with, from its root file paths (and its
 * parsed package.json, when given): Next.js wins over TanStack Start, which
 * wins over plain Vite (a Start app has a vite.config too); null when none.
 */
export const detectFramework = (paths: Iterable<string>, pkg?: PackageJson | null): Framework | null => {
  const all = [...paths];
  if (!all.includes("package.json")) return null;
  const usesNext = all.some((path) => /^next\.config\.[cm]?[jt]s$/.test(path)) || hasDep(pkg, "next");
  if (usesNext) return "next";
  const usesVite = all.some((path) => /^vite\.config\.[cm]?[jt]s$/.test(path));
  // Without a parsed package.json, Start's root route is the tell. With one, the dependency
  // decides, since a plain TanStack Router + Vite SPA has the same root route.
  if (hasDep(pkg, "@tanstack/react-start") || (!pkg && usesVite && all.includes("src/routes/__root.tsx"))) {
    return "tanstack-start";
  }
  return usesVite ? "vite" : null;
};

/** Frameworks with a server the in-browser engine can't run, so the preview always uses the E2B sandbox. */
export const needsSandbox = (framework: Framework | null | undefined) =>
  framework === "next" || framework === "tanstack-start";
