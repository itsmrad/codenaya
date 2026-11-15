/** Newest vite 6.x / plugin-react 4.x (npm view, 2026-11-15): the last pair that passes WebContainer HMR. */
export const WEBCONTAINER_VITE_PINS = {
  vite: "6.4.6",
  "@vitejs/plugin-react": "4.7.0",
} as const;

type Deps = Record<string, string>;

/**
 * Returns package.json with vite downgraded for WebContainer, or null to leave it as-is.
 * Only the mounted copy changes; the stored project keeps Vite 8 for E2B.
 */
export const pinViteForWebContainer = (packageJson: string): string | null => {
  let pkg: { dependencies?: Deps; devDependencies?: Deps };
  try {
    pkg = JSON.parse(packageJson);
  } catch {
    return null;
  }
  if (!pkg || typeof pkg !== "object") return null;

  const sections = [pkg.dependencies, pkg.devDependencies].filter(
    (deps): deps is Deps => !!deps && typeof deps === "object",
  );
  const viteSpec = sections.find((deps) => typeof deps.vite === "string")?.vite;
  const major = Number(viteSpec?.match(/\d+/)?.[0]);
  if (!(major >= 8)) return null;

  // shortcut: WebContainer pinned to vite 6.x because Vite 8 HMR restart fails 2/6 there; re-test when WebContainer support improves
  for (const deps of sections) {
    for (const name of Object.keys(WEBCONTAINER_VITE_PINS) as Array<keyof typeof WEBCONTAINER_VITE_PINS>) {
      if (name in deps) deps[name] = WEBCONTAINER_VITE_PINS[name];
    }
  }
  return `${JSON.stringify(pkg, null, 2)}\n`;
};
