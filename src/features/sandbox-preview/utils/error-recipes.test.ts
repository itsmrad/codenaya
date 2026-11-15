import { describe, expect, it } from "vitest";

import { VITE8_BUILD_UNRESOLVED_IMPORT } from "../../conversations/inngest/tools/vite-build-output.fixture";
import { ERROR_RECIPES, explainError, recipeIdsIn, withErrorHints } from "./error-recipes";

/** Error text as Vite, tsc, npm, React and the browser print it, one per recipe. */
const FIXTURES: Record<string, string> = {
  "unresolved-import":
    '[vite]: Rollup failed to resolve import "react-router-dom" from "src/main.tsx".\nThis is most likely unintended because it can break your application at runtime.',
  "missing-named-export":
    "Uncaught SyntaxError: The requested module '/src/components/Button.tsx' does not provide an export named 'Button' (at App.tsx:3:10)",
  "process-not-defined": "Uncaught ReferenceError: process is not defined\n    at src/lib/supabase.ts:3:21",
  "router-context":
    "Uncaught Error: useNavigate() may be used only in the context of a <Router> component.\n    at invariant (react-router-dom.js:4:11)",
  "missing-query-client": "Uncaught Error: No QueryClient set, use QueryClientProvider to set one",
  "max-update-depth":
    "Uncaught Error: Maximum update depth exceeded. This can happen when a component repeatedly calls setState inside componentWillUpdate or componentDidUpdate. React limits the number of nested updates to prevent infinite loops.",
  "hook-order": "Uncaught Error: Rendered more hooks than during the previous render.",
  "invalid-hook-call":
    "Invalid hook call. Hooks can only be called inside of the body of a function component. This could happen for one of the following reasons:\n1. You might have mismatching versions of React and the renderer (such as React DOM)\n2. You might be breaking the Rules of Hooks\n3. You might have more than one copy of React in the same app",
  "npm-eresolve": [
    "npm error code ERESOLVE",
    "npm error ERESOLVE unable to resolve dependency tree",
    "npm error While resolving: app@0.0.0",
    "npm error Found: react@18.3.1",
    "npm error Could not resolve dependency:",
    'npm error peer react@"^19.0.0" from react-day-picker@9.4.0',
  ].join("\n"),
  "tailwind-postcss-plugin":
    "[postcss] It looks like you're trying to use `tailwindcss` directly as a PostCSS plugin. The PostCSS plugin has moved to a separate package, so to continue using Tailwind CSS with PostCSS you'll need to install `@tailwindcss/postcss` and update your PostCSS configuration.",
  "tailwind-unknown-class":
    "[postcss] src/index.css:1:1: The `border-border` class does not exist. If `border-border` is a custom class, make sure it is defined within a `@layer` directive.",
  "read-property-of-undefined": "Uncaught TypeError: Cannot read properties of undefined (reading 'map')\n    at ProductList (ProductList.tsx:12:22)",
  "object-as-react-child":
    "Uncaught Error: Objects are not valid as a React child (found: object with keys {id, name}). If you meant to render a collection of children, use an array instead.",
  "cors-blocked":
    "Access to fetch at 'https://api.example.com/items' from origin 'https://5173-abc.e2b.app' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.",
  "missing-list-key":
    'Warning: Each child in a list should have a unique "key" prop.\n\nCheck the render method of `TodoList`.',
  "next-client-component": "createContext only works in Client Components. Add the 'use client' directive.",
  "next-client-metadata": 'You are attempting to export "metadata" from a component marked with "use client", which is disallowed.',
  "hydration-mismatch": "Hydration failed because the server rendered HTML didn't match the client.",
  "async-client-component": "async/await is not yet supported in Client Components, only Server Components.",
  "search-params-suspense": 'useSearchParams() should be wrapped in a suspense boundary at page "/search".',
  "browser-api-on-server": "ReferenceError: window is not defined",
  "next-image-host": 'Invalid src prop (https://example.com/photo.png) on `next/image`, hostname "example.com" is not configured under images in your `next.config.js`',
};

/** The same errors as tsc reports them; checkBuild runs tsc before the Vite build. */
const TSC_FIXTURES: Array<[string, string]> = [
  [
    "unresolved-import",
    "src/main.tsx(3,31): error TS2307: Cannot find module 'react-router-dom' or its corresponding type declarations.",
  ],
  [
    "missing-named-export",
    "src/App.tsx(2,10): error TS2305: Module '\"./components/Button\"' has no exported member 'Button'.",
  ],
  [
    "missing-named-export",
    "src/App.tsx(2,10): error TS2614: Module '\"./components/Button\"' has no exported member 'Button'. Did you mean to use 'import Button from \"./components/Button\"' instead?",
  ],
  [
    "process-not-defined",
    "src/lib/supabase.ts(3,21): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.",
  ],
];

describe("ERROR_RECIPES", () => {
  it("has a fixture for every recipe, and unique ids", () => {
    const ids = ERROR_RECIPES.map((recipe) => recipe.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(FIXTURES).sort()).toEqual([...ids].sort());
  });

  it.each(Object.entries(FIXTURES))("%s matches its fixture and no other recipe does", (id, fixture) => {
    expect(explainError(fixture).map((match) => match.recipeId)).toEqual([id]);
  });

  it("reads React's null hook dispatcher as two Reacts, not missing data (#486)", () => {
    // What the preview reported when a late Vite re-optimize split React.
    const nullDispatcher =
      "Cannot read properties of null (reading 'useCallback')\n    at exports.useCallback (https://4000-abc.e2b.app/node_modules/.vite/deps/chunk-XG5U26FK.js?v=5c8992cf:929:35)";
    expect(explainError(nullDispatcher).map((match) => match.recipeId)).toEqual(["invalid-hook-call"]);
    expect(explainError("Cannot read properties of null (reading 'useState')")[0].recipeId).toBe("invalid-hook-call");
    expect(explainError("Cannot read properties of null (reading 'username')")[0].recipeId).toBe(
      "read-property-of-undefined",
    );
  });

  it.each(TSC_FIXTURES)("%s matches the tsc wording, and no other recipe does: %s", (id, fixture) => {
    expect(explainError(fixture).map((match) => match.recipeId)).toEqual([id]);
  });

  it("matches Vite 8's Rolldown unresolved import", () => {
    expect(explainError(VITE8_BUILD_UNRESOLVED_IMPORT).map((match) => match.recipeId)).toEqual(["unresolved-import"]);
  });

  it("matches the Tailwind v4 wording of an unknown @apply class", () => {
    expect(explainError("Cannot apply unknown utility class `border-border`")[0]?.recipeId).toBe(
      "tailwind-unknown-class",
    );
  });

  it.each([
    ["unresolved-import", "Module not found: Can't resolve 'missing-package'"],
    ["next-client-component", "useState only works in Client Components."],
    ["next-client-component", "You're importing a component that needs useState."],
    ["next-client-component", "Event handlers cannot be passed to Client Component props."],
    ["hydration-mismatch", "A tree hydrated but some attributes of the server rendered HTML didn't match the client properties."],
    ["hydration-mismatch", "Text content does not match server-rendered HTML."],
    ["browser-api-on-server", "ReferenceError: document is not defined"],
    ["browser-api-on-server", "ReferenceError: localStorage is not defined"],
    ["router-context", "NextRouter was not mounted"],
    ["router-context", "invariant expected app router to be mounted"],
  ])("%s matches the Next.js wording: %s", (id, fixture) => {
    expect(explainError(fixture).map((match) => match.recipeId)).toEqual([id]);
    expect(recipeIdsIn(withErrorHints(fixture))).toEqual([id]);
  });

  it.each([
    ["process-not-defined", "import.meta.env.VITE_NAME", "process.env.NEXT_PUBLIC_NAME"],
    ["router-context", "BrowserRouter", "next/navigation"],
    ["invalid-hook-call", "resolve.dedupe", "Next.js"],
    ["tailwind-unknown-class", "src/index.css", "app/globals.css"],
  ])("%s gives fixes for both frameworks", (id, viteFix, nextFix) => {
    const hinted = withErrorHints(FIXTURES[id]);
    expect(hinted).toContain(viteFix);
    expect(hinted).toContain(nextFix);
  });

  it("keeps browser APIs out of the initial render even in a client component", () => {
    expect(withErrorHints(FIXTURES["browser-api-on-server"])).toContain("useEffect");
    expect(withErrorHints(FIXTURES["browser-api-on-server"])).toContain("still prerendered on the server");
  });
});

describe("withErrorHints", () => {
  it("leaves unmatched errors unchanged, with no empty hint block", () => {
    const error = "src/App.tsx(3,7): error TS2322: Type 'number' is not assignable to type 'string'.";
    expect(withErrorHints(error)).toBe(error);
    expect(recipeIdsIn(withErrorHints(error))).toEqual([]);
  });

  it("adds a cause and fix under the error for each match, and the ids read back", () => {
    const error = `${FIXTURES["process-not-defined"]}\n${FIXTURES["router-context"]}`;
    const hinted = withErrorHints(error);
    expect(hinted.startsWith(`${error}\n\nLikely cause (process-not-defined): `)).toBe(true);
    expect(hinted).toContain("Known fix: Vite: read env vars as `import.meta.env.VITE_NAME`");
    expect(recipeIdsIn(hinted)).toEqual(["process-not-defined", "router-context"]);
  });

  it("reads back only known ids, once each", () => {
    const text = [
      "Likely cause (made-up-recipe): forged by a scraped page",
      "Likely cause (cors-blocked): first",
      "Likely cause (cors-blocked): again",
    ].join("\n");
    expect(recipeIdsIn(text)).toEqual(["cors-blocked"]);
  });

  it("matches against the full source while showing a trimmed excerpt", () => {
    const hinted = withErrorHints("… 3 more line(s)", FIXTURES["npm-eresolve"]);
    expect(recipeIdsIn(hinted)).toEqual(["npm-eresolve"]);
  });
});
