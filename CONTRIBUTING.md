# Contributing to Codenaya

Thanks for helping. This guide covers setup, conventions and what a pull request needs before review. The standards reviewers hold code to are in [docs/ENGINEERING.md](docs/ENGINEERING.md); read it before your first PR.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately as described in [SECURITY.md](SECURITY.md), never in a public issue.

## Development setup

1. Fork and clone the repository, then install dependencies with npm (the repo uses `package-lock.json`; don't commit other lockfiles):

   ```bash
   npm install
   cp .env.example .env.local
   ```

2. Fill in the **Required** section of `.env.local`. [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) explains every variable, which ones belong on the Convex deployment, and how to inject secrets with Infisical.
3. Run the stack in three terminals:

   ```bash
   npx convex dev
   npm run dev
   npx inngest-cli@latest dev
   ```

4. Before touching anything in `convex/`, read [`convex/_generated/ai/guidelines.md`](convex/_generated/ai/guidelines.md). It overrides what you may remember about Convex APIs.

## Finding something to work on

- Look for issues labeled [`good first issue`](https://github.com/itsmrad/codenaya/labels/good%20first%20issue) or [`help wanted`](https://github.com/itsmrad/codenaya/labels/help%20wanted).
- [FEATURES.md](FEATURES.md) lists every user flow with its known gaps.
- For anything medium or larger (a new table or field, route or agent tool, or a change across features), open an issue or a draft PR with a short design note first, so the approach is agreed before you build it.

## Branches

Branch from `main` and keep one concern per branch:

| Prefix | Use |
| --- | --- |
| `feat/<slug>` | New feature |
| `fix/<slug>` or `fix/issue-<n>-<slug>` | Bug fix |
| `docs/<slug>` | Documentation only |
| `test/<slug>`, `chore/<slug>` | Tests, tooling, maintenance |

Bring a branch up to date with `git merge origin/main`. Don't rebase or force-push a branch others have pulled.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org) with a scope, in the imperative mood, lower case, no trailing period. Examples from this repo's history:

```text
feat(chat): show model reasoning in Thought rows
fix(#221): reference-check blob deletes so a remix can't delete the publisher's files
fix(swarm): cancel depth-2 workers with their sub-orchestrator
test(swarm): use existing e2e keyboard regression gate
docs: add contributor guide
```

Don't add AI attribution: no `Co-Authored-By` trailers for tools and no "Generated with" footers.

## Pull request checklist

Keep a PR under roughly 400 changed lines, not counting tests and generated files; split it otherwise. Before you ask for review:

- [ ] `npx tsc --noEmit` passes
- [ ] `npm run lint` reports 0 errors
- [ ] `npm test` passes
- [ ] `npm run build` passes
- [ ] The affected Playwright specs pass (`npx playwright test e2e/<spec>.spec.ts`; see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#running-e2e-tests))
- [ ] New or changed behavior has tests (see below)
- [ ] Convex schema changes are backward compatible: new fields optional, nothing removed or renamed without a migration
- [ ] UI changes include screenshots in the PR body
- [ ] The PR body covers context, approach, out of scope, verification, and `Closes #<n>`

CI runs the typecheck, lint, unit tests and build on every PR (and the mobile checks when `mobile/`, `src/` or `convex/` change). Playwright is not in CI because it needs live services, so run the affected specs locally.

## Tests

Tests are required for new logic and for every bug fix (write the failing test first).

| Layer | Tool | Where |
| --- | --- | --- |
| Pure functions | Vitest | `*.test.ts` next to the file |
| Convex functions | convex-test, including the negative authorization case | `convex/<domain>.test.ts` |
| API routes with branching validation | Vitest with mocked Clerk and Convex | `src/app/api/**/route.test.ts` |
| User flows | Playwright | `e2e/<flow>.spec.ts` |

e2e specs sign in through the Clerk test-user pool and stub the model with `e2e/stub-provider.ts`, so they never spend real credits. Specs that need a secret skip themselves with `test.skip(!process.env.X, "reason")`.

## Architecture decision records

Decisions that are expensive to reverse (a new module or pattern, a new dependency or external service, a schema shape, a change across features) need an ADR:

1. Copy [`docs/adr/0000-template.md`](docs/adr/0000-template.md) to `docs/adr/NNNN-kebab-title.md` with the next free number.
2. Fill in context, decision, alternatives and consequences, pointing at real files and issues.
3. Land it in the same PR as the change.

Accepted ADRs are not edited. To change a decision, write a new ADR and mark the old one `Superseded by NNNN`.

## Code style

- TypeScript everywhere; files and folders in `kebab-case`, components in `PascalCase`, hooks as `use-*.ts`.
- Feature code lives in `src/features/<feature>/` and Convex code in `convex/`; follow the module boundaries in [docs/ENGINEERING.md](docs/ENGINEERING.md#2-module-boundaries).
- Comments explain why, not what. Link the issue when a line exists because of a bug.
- Prefer dependencies that are already installed. A new dependency needs a sentence in the PR body on why existing code can't do the job.
- Delete code you replace in the same PR.

## License

Codenaya is licensed under [AGPL-3.0-only](LICENSE). By submitting a contribution, you agree that it is licensed under the same terms.
