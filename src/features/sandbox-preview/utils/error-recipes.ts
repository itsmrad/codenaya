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

export const ERROR_RECIPES: readonly ErrorRecipe[] = [
  {
    id: "unresolved-import",
    // Vite, then tsc (TS2307), which checkBuild runs before the Vite build.
    match: /failed to resolve import|Cannot find module '[^']+' or its corresponding type declarations/i,
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
    cause: "Browser code reads `process.env`, which only exists in Node; Vite does not define `process` in the browser.",
    fix: "Read env vars as `import.meta.env.VITE_NAME` (the name must start with VITE_) and keep server secrets out of browser code; do not add @types/node to silence it.",
  },
  {
    id: "router-context",
    match: /may be used only in the context of a <Router>/i,
    cause: "A React Router hook or <Link> renders outside a router, often a component rendered above or beside <BrowserRouter>.",
    fix: "Wrap the whole app once in <BrowserRouter> in src/main.tsx (or App.tsx) so every route and link renders inside it.",
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
    match: /Invalid hook call/i,
    cause: "A hook is called outside a function component or custom hook, or two copies of React are installed.",
    fix: "Only call hooks inside components or `use*` functions; keep react and react-dom on the same version in package.json.",
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
    fix: 'Add the color under theme.extend.colors (e.g. border: "hsl(var(--border))") and define its CSS variable in src/index.css, or apply an existing utility.',
  },
  {
    id: "read-property-of-undefined",
    match: /Cannot read propert(?:y|ies) of (?:undefined|null)/i,
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
