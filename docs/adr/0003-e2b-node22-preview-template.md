# 0003. Cloud previews boot from a custom E2B Node 22 template

- Status: Accepted
- Date: 2026-10-14
- Related: #178, #189, #146, #289

## Context

Generated apps run in two preview engines. **E2B** is a server-side sandbox
(`src/app/api/sandbox/route.ts`) and the only engine that gets secret env vars.
**WebContainer** runs in the browser and gets public vars only.

E2B's `base` image ships Node 20.9. Vite 7 needs `^20.19 || >=22.12` (it calls
`crypto.hash`), so every scaffolded Vite 7 app crashed at startup in the E2B preview
(#178).

## Decision

- `e2b/build-template.mts` (`npm run e2b:template`) builds the official Node 22 LTS
  image into an E2B template named by `E2B_TEMPLATE` (default: `codenaya-node22`). E2B gives it the same `user`
  account and `/home/user` home that the route expects.
- The host may override `E2B_TEMPLATE`; when unset, the app warns once at module load and uses `codenaya-node22` for previews and build checks.
- Rebuild the template when the Node major version changes or the image needs new
  system packages. Change the template name when you make a breaking change.

## Alternatives considered

- **Pin Vite 6 in generated apps.** That holds users back on tooling and only postpones
  the problem.
- **Install a newer Node at sandbox boot.** It adds tens of seconds to every cold
  preview and depends on the network at boot.
- **Use WebContainer only.** It can't receive secret env vars, so full-stack apps
  wouldn't work.

## Consequences

- Previews of modern Vite apps work, and boot time matches the base image.
- Every environment needs its template built with that environment's `E2B_API_KEY`
  (README production checklist, step 5). A missing template fails sandbox creation with E2B's not-found error instead of falling back to the old Node.
- `e2e/preview-e2b-node.spec.ts` guards the Node version.

## Addendum: Vite 7 stays deferred (#466)

The manifest (`known-good-versions.ts`) keeps Vite `^6` and `@vitejs/plugin-react` `^4`.
Vite 7 and plugin-react 5 need Node `^20.19 || >=22.12` in **both** engines:

- **E2B:** `build-template.mts` uses `fromNodeImage("22")`, so a template built from the
  current `node:22` image is >=22.12. The version actually deployed isn't recorded;
  `e2e/preview-e2b-node.spec.ts` only guards the major. Without `E2B_TEMPLATE` the app warns and uses `codenaya-node22`, which must exist in the E2B team.
- **WebContainer:** boot pins no Node version (`@webcontainer/api` 1.6.4); its in-browser
  Node version is unverified.

Decision: don't change the manifest, prompt or `node-compat.ts` guard until `node -v`
is recorded from the deployed E2B template and a WebContainer boot, and a Vite 7 starter
is shown to build in both. A bump then updates the manifest and `node-compat.ts` together.
The weekly `manifest-registry.yml` check only uses a Node 22.0.0 floor and doesn't certify either runtime.
