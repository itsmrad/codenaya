import { describe, expect, it } from "vitest";

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

  it.each(TSC_FIXTURES)("%s matches the tsc wording, and no other recipe does: %s", (id, fixture) => {
    expect(explainError(fixture).map((match) => match.recipeId)).toEqual([id]);
  });

  it("matches the Tailwind v4 wording of an unknown @apply class", () => {
    expect(explainError("Cannot apply unknown utility class `border-border`")[0]?.recipeId).toBe(
      "tailwind-unknown-class",
    );
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
    expect(hinted).toContain("Known fix: Read env vars as `import.meta.env.VITE_NAME`");
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
