# 0004. e2e tests sign in from a pool of Clerk test users

- Status: Accepted
- Date: 2026-10-14
- Related: #165, #175

## Context

Most flows (IDE, chat, preview, settings) are signed in. Several worktrees run
Playwright at once against the shared Clerk DEV instance. When they all shared one test
user and created a new session per test, sessions piled up until Clerk began ending
new ones right after sign-in, and signed-in specs failed at random.

## Decision

- `e2e/clerk-auth.ts` signs in through the Clerk Backend API with a one-time sign-in
  ticket and a testing token. Nothing goes through the UI.
- Each run uses one user from a pool of six, `codenaya-e2e-<n>+clerk_test@example.com`.
  `n` is `E2E_USER_INDEX` when set, otherwise `E2E_PORT % 6 + 1`. `E2E_EMAIL` pins a
  specific user.
- `e2e/global-setup.ts` creates the user if needed, revokes sessions idle for more than
  an hour, signs in once and saves storage state to `playwright/.auth/` (gitignored).
  Specs call `signIn(page)`, which reuses that state.
- Global setup also provides `E2E_PROJECT_ID`, the user's `e2e fixture` project.
- Specs that need Clerk or provider secrets skip themselves when the variable is
  missing (`test.skip(!process.env.X, ...)`), and run under `infisical run`.

## Alternatives considered

- **Sign in through the UI per test.** It's slow, flaky against bot protection, and it
  was the source of the session pile-up.
- **Mock Clerk in e2e.** That stops testing the real middleware and Convex JWT path,
  which is where auth bugs live.
- **One user per test.** It would create thousands of users and run into Clerk DEV
  limits.

## Consequences

- Parallel runs from different worktrees don't share sessions. Two runs whose ports
  collide modulo 6 need distinct `E2E_USER_INDEX` values.
- Specs must not assume an empty account, because pool users accumulate data. Create
  what a spec needs, or use the fixture project.
- Signed-in specs can't run without Clerk DEV secrets, so CI has to provide them or
  those specs skip.
