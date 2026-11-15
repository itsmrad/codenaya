/**
 * Known causes and fixes for errors generated apps hit again and again, so the
 * agent gets the likely cause next to the raw error instead of guessing (#334).
 *
 * Consumers (checkBuild today; Fix with AI #223 and the browser check #305
 * when they land) append `withErrorHints(text)` to the error text they send
 * to the model. `explainError` is the pure lookup behind it, and
 * `recipeIdsIn` reads the matched ids back out of a hinted text so a run can
 * record them (#297 ranks recipes, #306 spots repeats).
 */

export interface ErrorRecipe {
  /** Stable kebab-case id, recorded on run steps. Never rename one. */
  id: string;
  match: RegExp;
  cause: string;
  fix: string;
}

export interface ErrorExplanation {
  recipeId: string;
  cause: string;
  fix: string;
}

// React's null hook dispatcher: "Cannot read properties of null (reading 'useState')".
const HOOK_READ = String.raw`\(reading 'use(?:State|Reducer|Effect|LayoutEffect|InsertionEffect|Callback|Memo|Ref|Context|Id|SyncExternalStore|Transition|DeferredValue|ImperativeHandle)'\)`;

export const ERROR_RECIPES: readonly ErrorRecipe[] = [
  {
    id: "unresolved-import",
    // Vite (Rolldown: UNRESOLVED_IMPORT), tsc (TS2307), and Next.js.
    match: /failed to resolve import|\bUNRESOLVED_IMPORT\b|Cannot find module '[^']+' or its corresponding type declarations|Module not found: Can't resolve/i,
    cause: "An import points to a file that does not exist (wrong path or letter case) or to a package missing from package.json.",
    fix: "Correct the import path or create the missing file; for a package, add it to package.json dependencies.",
  },
  {
    id: "missing-named-export",
    // Browser, Rollup, then tsc (TS2305, TS2614).
    match: /does not provide an export named|is not exported by|has no exported member/i,
    cause: "A named import does not match what the module exports, usually a default export imported with braces or the reverse.",
    fix: "Match the import to the export: `import X from` for `export default`, `import { X } from` for `export const X`/`export function X`.",
  },
  {
    id: "process-not-defined",
    // Browser, then tsc (TS2580).
    match: /process is not defined|Cannot find name 'process'/i,
    cause: "Browser code reads `process` without the framework's supported environment variable replacement; Vite does not define `process` in the browser.",
    fix: "Vite: read env vars as `import.meta.env.VITE_NAME` (the name must start with VITE_). Next.js: use `process.env.NEXT_PUBLIC_NAME` in client code and plain `process.env.NAME` on the server. Keep server secrets out of browser code; do not add @types/node to silence a browser runtime error.",
  },
  {
    id: "router-context",
    match: /may be used only in the context of a <Router>|NextRouter was not mounted|expected app router to be mounted/i,
    cause: "A router hook or link runs outside its router context, or a Next.js App Router component uses the Pages Router hook.",
    fix: "Vite with React Router: wrap the whole app once in <BrowserRouter> in src/main.tsx (or App.tsx). Next.js App Router: use hooks from `next/navigation` inside a Client Component and links from `next/link`; do not add BrowserRouter to fix Next.js routing.",
  },
  {
    id: "missing-query-client",
    match: /No QueryClient set/i,
    cause: "A TanStack Query hook runs without a QueryClientProvider above it.",
    fix: "Create one `new QueryClient()` at module level and wrap the app in <QueryClientProvider client={queryClient}> in src/main.tsx.",
  },
  {
    id: "max-update-depth",
    match: /Maximum update depth exceeded/i,
    cause: "A state update re-runs itself: setState during render, or a useEffect that sets state its own dependencies change.",
    fix: "Move setState out of render, give the effect stable dependencies (memoize objects and callbacks), and only set state when the value changes.",
  },
  {
    id: "hook-order",
    match: /Rendered (?:more|fewer) hooks than/i,
    cause: "A hook is called conditionally or after an early return, so the number of hooks changes between renders.",
    fix: "Call every hook at the top level of the component, before any early return or condition.",
  },
  {
    id: "invalid-hook-call",
    match: new RegExp(`Invalid hook call|of null ${HOOK_READ}`, "i"),
    cause: "A hook is called outside a function component or custom hook, or the page runs two copies of React; a null dispatcher inside node_modules/.vite/deps usually means Vite pre-bundled a package it found only after the page loaded.",
    fix: 'Only call hooks inside components or `use*` functions; keep react and react-dom on the same version in package.json. Vite: keep `resolve.dedupe: ["react", "react-dom"]` in vite.config.ts; Vite restarts itself on config changes, so never ask the user to restart the preview or delete node_modules/.vite. Next.js: keep hook-using components behind a "use client" boundary and use React versions supported by the installed Next.js version.',
  },
  {
    id: "npm-eresolve",
    match: /\bERESOLVE\b/,
    cause: "A package's peer dependency does not accept the installed major version (often React or Vite).",
    fix: "Change that package to a version whose peer range includes the installed major, or drop it; do not add --force or --legacy-peer-deps.",
  },
  {
    id: "tailwind-postcss-plugin",
    match: /trying to use `?tailwindcss`? directly as a PostCSS plugin/i,
    cause: "Tailwind CSS v4 was installed, but the project is set up for v3 (tailwind.config.ts and the `tailwindcss` PostCSS plugin).",
    fix: 'Pin "tailwindcss": "^3.4.17" in package.json to match the existing config; do not mix v3 and v4 setup.',
  },
  {
    id: "tailwind-unknown-class",
    match: /The `[^`]+` class does not exist|Cannot apply unknown utility class/i,
    cause: "`@apply` names a utility Tailwind does not generate, usually a theme color like `border-border` missing from tailwind.config.",
    fix: 'Add the color under theme.extend.colors (e.g. border: "hsl(var(--border))") and define its CSS variable in the global stylesheet (Vite: src/index.css; Next.js: app/globals.css or src/app/globals.css), or apply an existing utility.',
  },
  {
    id: "next-client-component",
    match: /only works in Client Components|You're importing a component that needs (?:use\w+|createContext)|Event handlers cannot be passed to Client Component props/i,
    cause: "A Server Component uses client hooks, context, or event handlers, or passes an event handler across the server/client boundary.",
    fix: 'Move the interactive code into a small component with "use client" as its first directive. Define event handlers inside that Client Component and pass serializable data from its server parent; keep server-only code in Server Components.',
  },
  {
    id: "next-client-metadata",
    match: /You are attempting to export ["']metadata["'] from a component marked with ["']use client["']/i,
    cause: "Next.js metadata exports are server-only, but the page or layout is marked as a Client Component.",
    fix: 'Keep the metadata export in a Server Component page.tsx or layout.tsx; move interactive UI into a separate "use client" component imported by that server file.',
  },
  {
    id: "hydration-mismatch",
    match: /Hydration failed|A tree hydrated but some attributes of the server rendered HTML didn't match|Text content does not match/i,
    cause: "The server HTML differs from the client's initial render, often due to browser APIs, dates, random values, or invalid HTML nesting.",
    fix: "Make the server and initial client render deterministic, fix invalid HTML nesting, and move browser-only reads or changing values into useEffect. Do not hide the mismatch with suppressHydrationWarning.",
  },
  {
    id: "async-client-component",
    match: /async\/await is not yet supported in Client Components/i,
    cause: "A Client Component is async; async component rendering belongs on the server.",
    fix: "Move async data fetching into a parent Server Component and pass serializable results to a synchronous Client Component, or fetch inside a client effect.",
  },
  {
    id: "search-params-suspense",
    match: /useSearchParams\(\) should be wrapped in a suspense boundary/i,
    cause: "A statically rendered Next.js route calls useSearchParams without a Suspense boundary above the calling component.",
    fix: "Move useSearchParams into a small Client Component and wrap that component in <Suspense fallback={...}> from its parent page; the boundary must be above the hook call.",
  },
  {
    id: "browser-api-on-server",
    match: /\b(?:window|document|localStorage) is not defined\b/i,
    cause: "Server rendering or module initialization reads a browser-only API; Next.js Client Components are still prerendered on the server.",
    fix: 'Move browser API reads into useEffect or event handlers in a "use client" component, with a stable initial render. For a browser-only library, load it in the effect or use next/dynamic with ssr: false inside a Client Component; adding "use client" alone does not prevent server rendering.',
  },
  {
    id: "next-image-host",
    match: /next\/image[\s\S]*hostname ["'][^"']+["'] is not configured/i,
    cause: "A remote image URL is not allowed by the Next.js image configuration.",
    fix: "Add the image's exact protocol, hostname and path under images.remotePatterns in next.config.js or next.config.ts, or use a local image. Avoid allowing arbitrary remote hosts.",
  },
  {
    id: "read-property-of-undefined",
    match: new RegExp(`Cannot read propert(?:y|ies) of (?:undefined|null(?! ${HOOK_READ}))`, "i"),
    cause: "Code reads a field of a value that is not there yet: data still loading, a wrong response shape, or a missing prop.",
    fix: "Give the state a safe initial value (e.g. `[]`), guard with optional chaining or a loading state, and check the data's real shape.",
  },
  {
    id: "object-as-react-child",
    match: /Objects are not valid as a React child/i,
    cause: "JSX renders a plain object (or a Date or Promise) instead of a string, number or element.",
    fix: "Render a field of the object (e.g. `{item.name}`), map arrays to elements, or format the value as a string.",
  },
  {
    id: "cors-blocked",
    match: /has been blocked by CORS policy/i,
    cause: "The browser called an API that does not allow requests from this site's origin.",
    fix: "Use an API or endpoint that supports browser CORS, or call it from a server-side function; headers set in the browser cannot fix CORS.",
  },
  {
    id: "missing-list-key",
    match: /Each child in a list should have a unique "key" prop/i,
    cause: "Warning: elements rendered from an array have no stable `key`.",
    fix: "Give each mapped element a unique, stable key from the data (e.g. `key={item.id}`), not the array index if the list can change.",
  },
];

/** Every recipe whose pattern appears in `text`, in table order. Pure. */
export const explainError = (text: string): ErrorExplanation[] =>
  ERROR_RECIPES.filter((recipe) => recipe.match.test(text)).map(({ id, cause, fix }) => ({
    recipeId: id,
    cause,
    fix,
  }));

const CAUSE_LINE = /^Likely cause \(([a-z0-9-]+)\):/gm;
const RECIPE_IDS = new Set(ERROR_RECIPES.map((recipe) => recipe.id));

/**
 * `shown` with a "Likely cause / Known fix" block for each recipe matched in
 * `source` (default: `shown`), or `shown` unchanged when nothing matches.
 * Pass the untrimmed output as `source` when `shown` is a trimmed excerpt.
 */
export const withErrorHints = (shown: string, source = shown) => {
  const matches = explainError(source);
  if (matches.length === 0) return shown;
  const hints = matches.map(
    ({ recipeId, cause, fix }) => `Likely cause (${recipeId}): ${cause}\nKnown fix: ${fix}`,
  );
  return `${shown}\n\n${hints.join("\n")}`;
};

/**
 * The recipe ids in a text produced by `withErrorHints`, deduplicated. Only
 * known ids count: any tool result (a scraped page, a file) can contain the
 * line, and the run record must stay small.
 */
export const recipeIdsIn = (text: string) => [
  ...new Set(
    [...text.matchAll(CAUSE_LINE)].map((match) => match[1]).filter((id) => RECIPE_IDS.has(id)),
  ),
];
