export type Framework = "vite" | "next";

type PackageJson = { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };

/**
 * The framework a project is built with, from its root file paths (and its
 * parsed package.json, when given): Next.js wins over Vite, null when neither.
 */
export const detectFramework = (paths: Iterable<string>, pkg?: PackageJson | null): Framework | null => {
  const all = [...paths];
  if (!all.includes("package.json")) return null;
  const usesNext =
    all.some((path) => /^next\.config\.[cm]?[jt]s$/.test(path)) ||
    !!(pkg?.dependencies?.next ?? pkg?.devDependencies?.next);
  if (usesNext) return "next";
  return all.some((path) => /^vite\.config\.[cm]?[jt]s$/.test(path)) ? "vite" : null;
};
