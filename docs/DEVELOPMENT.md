# Development guide

Local environment, secrets and end-to-end tests. For the short version, see [Quickstart](../README.md#quickstart) in the README.

## Environment & secrets

`.env.example` is the reference for every variable: required vs optional, a one-line description, and a tag for where it is read:

- **[Next]** by the Next.js server (and Inngest functions, which run inside it).
- **[Convex]** by Convex functions, which run on Convex's servers and see only the deployment's own env: `CLERK_JWT_ISSUER_DOMAIN`, `CLERK_WEBHOOK_SECRET`, `SHOWCASE_UNLISTED_OWNER_IDS`.
- **[Both]** in both places, with the same value: `CODENAYA_CONVEX_INTERNAL_KEY`.

### Infisical

Secrets live in the Infisical project `codenaya` (environments: `dev`, `staging`, `prod`). The project is linked via `.infisical.json`, which holds no secret values. Never commit `.env*` files or paste secret values into issues or PRs.

```bash
infisical login                    # once per machine
npm run dev:infisical              # next dev with dev secrets injected
infisical run --env dev -- <cmd>   # inject secrets into any other command
```

Outside the repo root (or in a worktree without `.infisical.json`), pass the project explicitly: `infisical run --env dev --projectId 2aecb08a-77b7-45fb-b366-57a36ffab934 -- <cmd>`. `NEXT_PUBLIC_CONVEX_URL` and `CONVEX_DEPLOYMENT` are written to `.env.local` by `npx convex dev`.

Infisical only injects secrets into local processes. Convex variables must also be set on the deployment:

```bash
npx convex env set NAME value          # dev deployment
npx convex env set --prod NAME value   # production deployment
```


## Running e2e tests

End-to-end tests use [Playwright](https://playwright.dev) and live in `e2e/`.

```bash
npx playwright install chromium   # once; skipped if ~/.cache/ms-playwright already has it
npm run test:e2e                  # starts `next dev` on port 3113 (or reuses a running one)
```

Set `E2E_PORT` to use another port. Failure screenshots and traces go to `test-results/`; open the HTML report with `npx playwright show-report`. Specs that need auth or secrets should call `test.skip(!process.env.SOME_VAR, "reason")` so they skip cleanly when the env var is absent.

Signed-in specs use `e2e/clerk-auth.ts`, which needs `CLERK_SECRET_KEY` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (run under `infisical run`). Each run signs in as one user from a pool of Clerk DEV test users, `codenaya-e2e-<n>+clerk_test@example.com`, so parallel runs from different worktrees never share a session:

- `n` is `E2E_USER_INDEX` if set, else `E2E_PORT % 6 + 1`; give runs whose ports collide distinct `E2E_USER_INDEX` values. `E2E_EMAIL` pins one specific user instead.
- `e2e/global-setup.ts` creates the user if needed, revokes its sessions idle for over an hour, signs in once and saves the session to `playwright/.auth/` (gitignored); `signIn(page)` reuses it.
- It also sets `E2E_PROJECT_ID` to the user's `e2e fixture` project, creating it on first use. With `E2E_EMAIL` set, `E2E_PROJECT_ID` must name a project that user owns.

Opt-in specs skip unless their vars are set:

| Variable | Spec | Value |
| --- | --- | --- |
| `E2E_DISPATCH_UNREACHABLE` | `chat-dispatch-failure.spec.ts` | `1`, against a dev server whose Inngest URLs point nowhere (see the spec) |
| `E2E_LIVE_AGENT` | `agent-vite-scaffold.spec.ts` | `1`; also needs the Inngest dev server, `E2B_API_KEY` and `E2B_TEMPLATE` |
| `E2E_OPENAI_KEY` | `ai-providers.spec.ts` | a working OpenAI key; the server also needs `CODENAYA_LOCAL_KEK` |
| `E2E_STORAGE_STATE`, `E2E_PREVIEW_PATH` | `preview-device.spec.ts` | a Playwright storage-state file for a signed-in user, and a `/projects/<id>` path |

