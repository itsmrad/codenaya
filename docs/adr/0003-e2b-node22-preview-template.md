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
  image into an E2B template named `codenaya-node22`. E2B gives it the same `user`
  account and `/home/user` home that the route expects.
- The host sets `E2B_TEMPLATE=codenaya-node22`. The route reads it per environment and
  falls back to `base` when it's unset.
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
  (README production checklist, step 5). A missing variable quietly degrades to the
  old Node.
- `e2e/preview-e2b-node.spec.ts` guards the Node version.
