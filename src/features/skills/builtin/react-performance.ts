import type { BuiltinSkill } from "../types";

/**
 * Built-in skill: react-performance. The React performance rules that used to
 * sit in the coding agent's system prompt (#293), now loaded only when a task
 * needs them.
 */
const body = `# React performance

Apply these rules when building or optimizing a React app.

ELIMINATING WATERFALLS (CRITICAL):
- In Next.js: never await data fetches sequentially when they are independent — use Promise.all() to fetch in parallel
- In Vite: when multiple useEffect hooks fetch independent data, start all fetches immediately using Promise.all inside one effect
- Use Suspense boundaries to stream content progressively in Next.js App Router — wrap slow data components in <Suspense fallback={<ComponentSkeleton />}>
- Start promises early, await late in API routes and server actions

BUNDLE SIZE (CRITICAL):
- Import directly, never from barrel files: import { Button } from "@/components/ui/button" NOT from "@/components/ui"
- Use next/dynamic or React.lazy + Suspense for heavy components (rich text editors, charts, date pickers, map components)
- Load analytics and non-critical third-party scripts only after hydration (in useEffect or Next.js Script with strategy="afterInteractive")
- Only load a module when the feature is actually activated (conditional dynamic imports)

SERVER-SIDE (Next.js):
- Server Components are the default — only add "use client" when you need interactivity, browser APIs, or React hooks
- Use React.cache() for per-request data deduplication in server components
- Minimize data serialized from Server Components to Client Components — pass only what the client needs
- Hoist static I/O (fonts, static config) to module level, not inside render functions

CLIENT COMPONENTS:
- Use SWR or React Query for client-side data fetching with automatic deduplication
- Add passive event listeners for scroll: addEventListener("scroll", handler, { passive: true })
- Use useCallback and useMemo only when the memoization cost is clearly worth it (expensive computations or stable prop identity for children that do deep comparison)

RE-RENDER OPTIMIZATION:
- Don't subscribe to state values that are only used inside callbacks — read them in the callback directly using a ref or functional setState
- Use functional setState when new state depends on previous: setState(prev => prev + 1) — this creates stable callback references
- Derive state during render, not in effects: const isValid = value.length > 0 instead of useEffect + useState
- Use startTransition for non-urgent updates (search filtering, tab switching) so they don't block urgent re-renders
- Use refs (useRef) for transient, frequently-changing values that don't need to trigger a re-render (e.g. scroll position, timer IDs)
- Extract expensive or frequently re-rendered JSX into memoized components with React.memo

RENDERING PERFORMANCE:
- Use ternary conditionals, not && for JSX conditionals: {condition ? <A /> : null} — the && pattern causes 0 to render
- Hoist static JSX outside of components when it doesn't depend on props or state
- For lists with 50+ items, implement virtualization (react-window or react-virtual)
- Use content-visibility: auto CSS for long static page sections to defer off-screen rendering
- Reduce SVG coordinate precision to 1–2 decimal places for smaller bundle size
`;

export const reactPerformance: BuiltinSkill = {
  name: "react-performance",
  description:
    "React and Next.js performance rules: data-fetching waterfalls, bundle size, server components, re-renders and long lists. Use when building a data-heavy or large React app, or when asked to make one faster.",
  body,
};
