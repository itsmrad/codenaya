# Deployment

Production setup for the Next.js host, Convex, Clerk, E2B and Inngest. Variable names and where each one is read are listed in [`.env.example`](../.env.example) and [docs/DEVELOPMENT.md](DEVELOPMENT.md#environment--secrets).

1. **Next.js host env.** Set every Required `[Next]` variable from the Infisical `prod` environment, plus `NEXT_PUBLIC_APP_URL` (or `INTEGRATIONS_REDIRECT_URI`) for the real domain. Use the same `CODENAYA_LOCAL_KEK` as every other environment, or stored credentials cannot be decrypted.
2. **Convex env.** On the production deployment, set `CLERK_JWT_ISSUER_DOMAIN` (the production Clerk instance), `CLERK_WEBHOOK_SECRET` (step 4) and `CODENAYA_CONVEX_INTERNAL_KEY` (same value as the host).
3. **Convex deploy + backfill.** Deploy functions and schema with `npx convex deploy --cmd 'npm run build'` (needs `CONVEX_DEPLOY_KEY`; keep `npm run build` as plain `next build`). After the first deploy, backfill the landing-page project counter once: `npx convex run --prod stats:backfillProjectsBuilt '{}'`.
4. **Clerk webhook.** In the production Clerk instance, add a webhook to `https://<prod-deployment>.convex.site/clerk-users-webhook` with events `user.created`, `user.updated`, `user.deleted`; put its signing secret in Convex as `CLERK_WEBHOOK_SECRET`. Enable "Delete account" under User & authentication > Account settings.
5. **E2B template.** Run `npm run e2b:template` with the production `E2B_API_KEY` and optional `E2B_TEMPLATE` (build default: `codenaya-node22`), then set the same template name in `E2B_TEMPLATE` on the host. Without it previews use the `base` image, whose Node is too old for Vite 7. The template also warms the npm cache for the Next.js starter (ADR 0014); rebuild it when either starter's package.json changes.
6. **Inngest Cloud.** Set `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` on the host, leave `INNGEST_DEV` unset, and sync the app at `https://<your-domain>/api/inngest` (the Inngest Vercel integration does both automatically).

