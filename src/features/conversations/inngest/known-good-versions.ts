/**
 * Package ranges known to install and run together on the starter's stack
 * (#331). The starter's package.json, the system prompt's version list and the
 * package.json write check all read from here, so they can't drift apart.
 * Without it the agent wrote `latest` and got majors the starter can't run
 * (react-router 8 needs React >=19.2.7 and Node >=22.22). Ranges checked with
 * `npm view` on 2026-11-01.
 */
export const KNOWN_GOOD_VERSIONS = {
  // The Vite starter (vite-starter.ts).
  "@fontsource/inter": "^5.1.0",
  "class-variance-authority": "^0.7.1",
  clsx: "^2.1.1",
  "lucide-react": "^1.66.0",
  react: "^19.2.0",
  "react-dom": "^19.2.0",
  "tailwind-merge": "^3.7.0",
  "@tailwindcss/vite": "^4.3.0",
  "@types/node": "^22.10.0",
  "@types/react": "^19.2.0",
  "@types/react-dom": "^19.2.0",
  // Vite 7 and plugin-react 5 need Node 20.19+ (node-compat.ts).
  "@vitejs/plugin-react": "^4.3.4",
  tailwindcss: "^4.3.0",
  "tw-animate-css": "^1.4.0",
  typescript: "~5.6.3",
  vite: "^6.0.0",
  // Add-ons the prompt names.
  "react-router-dom": "^7.18.0",
  "react-router": "^7.18.0",
  "react-hook-form": "^7.55.0",
  "@hookform/resolvers": "^7.0.0",
  zod: "^4.0.0",
  "framer-motion": "^14.0.0",
  motion: "^14.0.0",
  zustand: "^5.0.0",
  sonner: "^2.0.0",
  recharts: "^3.0.0",
  "date-fns": "^4.0.0",
  "@tanstack/react-query": "^5.0.0",
  "@supabase/supabase-js": "^2.0.0",
  // Next.js apps.
  next: "^15.5.0",
  "@tailwindcss/postcss": "^4.3.0",
} as const satisfies Record<string, string>;

export type KnownGoodPackage = keyof typeof KNOWN_GOOD_VERSIONS;

/** `{ name: range }` for the given packages, for a package.json. */
export const pinnedVersions = (names: readonly KnownGoodPackage[]) =>
  Object.fromEntries(names.map((name) => [name, KNOWN_GOOD_VERSIONS[name]]));

/** The manifest as `"name": "range"` lines, for the system prompt. */
export const KNOWN_GOOD_VERSIONS_LINES = Object.entries(KNOWN_GOOD_VERSIONS)
  .map(([name, range]) => `  "${name}": "${range}"`)
  .join("\n");
