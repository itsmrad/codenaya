# 0014. Next.js App Router apps next to the Vite default

- Status: Accepted
- Date: 2026-11-15
- Related: ADR 0002 (agent runtime), #708 (detectFramework), #709 (Next starter and seeding),
  #710 (error capture and recipes), #711 (`next build` check), #712 (preview dev server and
  proxy), #725 (e2e specs), #726 (framework picker)

## Context

Every generated app was a Vite + React SPA. Users also ask for Next.js (server components,
route handlers, file routing). A plugin layer for arbitrary frameworks would be far more
code than the need justifies, so we support exactly two: `"vite" | "next"`.

## Decision

- **Vite stays the default.** Next.js 15 (App Router, Tailwind 4, same UI kit) is an explicit
  choice: the prompt says Next.js (`wantsNextJs`), or the composer picker sends `framework`
  (#709, #726). The project is seeded with `NEXT_APP_STARTER` instead of the Vite starter.
- **Detection is `detectFramework(paths, pkgJson)`** (#708), a pure function over the file
  tree and package.json. `isViteProject` and the build, repair and preview code branch on
  it; there is no framework flag stored anywhere.
- **Dev server:** `next dev -H 0.0.0.0` (never `--host`) behind the existing proxy. The proxy
  rewrites `Origin` to the target host (and `x-forwarded-*`) on HTTP and websocket upgrades,
  because Next 15.2+ flags cross-origin dev requests and Next 16 blocks them (#712). The port
  probe counts connect-then-timeout as open, since Next compiles `/` lazily.
- **`checkBuild` runs `next build`** (#711). It type-checks and compiles in one pass, so there
  is no separate `tsc` step. `.next`, `out` and `next-env.d.ts` are excluded from the tree.
- **Next is E2B-only.** The WebContainer engine has no bridge for Next, so Next projects
  force the E2B engine.
- **Runtime errors:** the preview bridge reads the Next overlay, and the app-error parser and
  recipes learn Next's `⨯` lines and App Router mistakes (#710).
- **Template warm-up.** `e2b/build-template.mts` warms the npm cache with both starters'
  package.json, so a Next preview's `npm install --prefer-offline` mostly resolves from disk.
  A template rebuild (`npm run e2b:template`) needs explicit approval and is separate from
  merging; until it runs, Next previews just install cold.

## Consequences

- The agent paths, error recipes and swarm shared paths carry a Next variant; no new tool.
- Known gaps (accepted for v1):
  - Switching framework mid-session (Vite to Next) changes the command, port and proxy target,
    so it needs a full preview restart, not the same-command restart used after a reinstall.
  - The proxy buffers whole HTML responses to inject the bridge, so App Router streaming and
    Suspense fallbacks are not streamed in the preview (correct, but slower first byte). A
    streaming injector is a follow-up.
- Revisit if a third framework is requested: replace the two small per-framework maps with a
  real adapter.
