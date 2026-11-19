# Deployment

Production setup for the Next.js host, Convex, Clerk, E2B (plus optional sandbox fallbacks) and Inngest. Variable names and where each one is read are listed in [`.env.example`](../.env.example) and [docs/DEVELOPMENT.md](DEVELOPMENT.md#environment--secrets).

1. **Next.js host env.** Set every Required `[Next]` variable from the Infisical `prod` environment, plus `NEXT_PUBLIC_APP_URL` (or `INTEGRATIONS_REDIRECT_URI`) for the real domain. Use the same `CODENAYA_LOCAL_KEK` as every other environment, or stored credentials cannot be decrypted.
2. **Convex env.** On the production deployment, set `CLERK_JWT_ISSUER_DOMAIN` (the production Clerk instance), `CLERK_WEBHOOK_SECRET` (step 4) and `CODENAYA_CONVEX_INTERNAL_KEY` (same value as the host).
3. **Convex deploy + backfill.** Deploy functions and schema with `npx convex deploy --cmd 'npm run build'` (needs `CONVEX_DEPLOY_KEY`; keep `npm run build` as plain `next build`). After the first deploy, backfill the landing-page project counter once: `npx convex run --prod stats:backfillProjectsBuilt '{}'`.
4. **Clerk webhook.** In the production Clerk instance, add a webhook to `https://<prod-deployment>.convex.site/clerk-users-webhook` with events `user.created`, `user.updated`, `user.deleted`; put its signing secret in Convex as `CLERK_WEBHOOK_SECRET`. Enable "Delete account" under User & authentication > Account settings.
5. **E2B template.** Run `npm run e2b:template` with the production `E2B_API_KEY` and optional `E2B_TEMPLATE` (build and app default: `codenaya-node22`); set the same name on the host if customized. When unset the app warns and uses `codenaya-node22`; a missing template fails sandbox creation with E2B's not-found error. The template also warms the npm cache for the Next.js starter (ADR 0014); rebuild it when either starter's package.json changes. **Blaxel (only when listed, see below):** set `BL_API_KEY`, `BL_WORKSPACE`, optional `BL_REGION` (default `us-was-1`) and `BLAXEL_IMAGE` (default `codenaya-node22`) on the host, and build the image with `npm run blaxel:template` using the same values; rebuild it with the E2B template.
6. **Inngest Cloud.** Set `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` on the host, leave `INNGEST_DEV` unset, and sync the app at `https://<your-domain>/api/inngest` (the Inngest Vercel integration does both automatically).


## Sandbox provider selection

`SANDBOX_PROVIDER` defaults to `e2b`; `SANDBOX_PROVIDER_FALLBACKS` is an
ordered comma list, empty by default. The supported ids are `e2b` (`E2B_API_KEY`)
and `blaxel` (`BL_API_KEY` and `BL_WORKSPACE`). A provider without all of its keys
is skipped, even when listed. Unknown ids are ignored with a warning that never
includes environment values. Session lifetime is bounded by one hour and the
provider's `maxSessionMs`.

With fallbacks set, a preview boot (share previews included) that hits a rate
limit, a quota or a config error continues on the next provider (at most two per
boot), and the failed one cools down for 10 minutes. A timeout does that only on
its second boot in a row. The per-user cap, project kills and sandbox lookups span
every configured provider. The agent paths (check-build, build repair, swarm)
still use E2B only.

**Keys, not the list, put a provider in the fan-out.** With `BL_API_KEY` and
`BL_WORKSPACE` set, every boot's cap check and project kill, and every preview
lookup, calls Blaxel's list even when `blaxel` is not in the fallbacks. A Blaxel
outage then fails every boot, E2B ones included (a hang costs about 60 s before
a 500). Runbook:
- Set `BL_*` on a host only when Blaxel is meant to be live there.
- In a Blaxel outage, remove the `BL_*` keys; taking `blaxel` out of
  `SANDBOX_PROVIDER_FALLBACKS` is not enough.
- Removing the keys while a share preview runs on Blaxel makes that share link
  error until its lease ends.

Intended production order: `SANDBOX_PROVIDER_FALLBACKS=blaxel,daytona`, with
Daytona last resort only. Because a boot tries at most two providers, Daytona is
reached only while E2B or Blaxel is cooling down. Below Daytona Tier 3, its
previews show a warning page the preview iframe cannot skip, and outbound traffic
is limited to an allowlist. Until a Daytona adapter is registered, `daytona` is
ignored with the warning above.

A provider with its keys set is listed by the cap, project kill and preview lookup
even when it is not in `SANDBOX_PROVIDER_FALLBACKS`. Each non-primary list gets 5 s.
If it fails or times out, that provider goes into the ten-minute failover cooldown.
The kill and the lookup skip it, and the cap skips it while it is cooling down. The
primary still fails closed. A non-primary kill or inspect that fails is treated
the same way. The cooldown is per server instance (per warm function on Vercel):
each instance learns about an outage on its own, a cold start begins with nothing
cooling, and every failure restarts the ten minutes, so the cap skip lasts as long
as the outage. Accepted risk: during such an outage a user can go over the 3-preview
cap by the sandboxes they have on the failing provider (at most 3, each live at most
one hour), and a hanging fallback adds about 5 s to every preview lookup (ADR 0015,
"Fan-out resilience"). To take a provider out during an outage, remove its keys,
not just its fallback entry.

TODO (privacy): update the subprocessor list BEFORE shipping any non-E2B adapter;
the privacy page currently names E2B, and sandbox env secrets reach the provider.
