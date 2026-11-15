# Live agent evaluation


`npm run eval:agent` runs real builds (dev Convex, E2B, platform models from the admin catalog: Claude Haiku/Sonnet/Opus 5.5, and `openai/gpt-6-luna` and `google/gemini-4-hydrogen` through OpenRouter) and scores them. It spends real money, so it never runs in CI. Start the stack, then run it under Infisical dev:

```bash
infisical run --env dev -- env INNGEST_BASE_URL=http://localhost:8299 npx next dev -p 3213
npx inngest-cli@latest dev -p 8299 -u http://localhost:3213/api/inngest --no-discovery
infisical run --env dev -- npm run eval:agent -- --models claude-haiku-5-5 --prompts booking,saas,crm --judge
```

Options: `--runs N`, `--max-usd X` per run (default Haiku 0.75, Sonnet 2, Opus 3; the run is cancelled through the app when its metered cost crosses it), `--budget-usd X` for the whole local ledger (default 2), `--judge` / `--judge-model`, `--keep` to keep the projects (deleted after scoring by default), `--as-admin` to build as the existing Clerk user holding `ADMIN_EMAIL` (looked up, never created; its projects are always kept, named by `--title`, default `Night build — {app} — {config}`), `--title "<template>"` with `{app}` and `{config}` placeholders, and `followup` (needs `saas`, runs as its second turn). Metering reads the dev `creditLedger` table with the read-only `npx convex data` CLI, so the Convex CLI must be logged in.

Each run signs in as `codenaya-eval-297+clerk_test@example.com`, sends the prompt, keeps the project page open through the preview auto-fix window and records a sanitized trail. Output goes to `scripts/agent-eval/results/<timestamp>/` (gitignored): `runs/<id>/{trail.json,score.json,app.png}` and `scoreboard.md`. The cumulative spend is in `scripts/agent-eval/results/ledger.json`. `firstAppPaintMs` is the time to the generated app's first paint, past the starter's "App" heading and its error boundary. An app that renders only images or a canvas has no text and leaves it empty. A Haiku 5.5 run of `booking,saas,crm --judge` cost $0.15 (about $0.08 per completed build, under $0.001 per judge call); see `scripts/agent-eval/baselines/`. Sonnet and Opus cost roughly 20× and 40× that.

To add a prompt from a real failure, put the user's prompt and a short rubric of what should be visible into `scripts/agent-eval/prompts.json`, then run it alone with `--prompts <name> --keep` and check the trail for the failing step.

