import { existsSync, readFileSync } from "node:fs";

import type { Page } from "@playwright/test";

/**
 * Signs a Clerk test user into the app without the UI.
 *
 * Uses the Clerk Backend API (needs `CLERK_SECRET_KEY` and
 * `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`): ensures the test user exists, adds a
 * testing token to Frontend API calls to get past bot protection, then signs in
 * with a one-time sign-in ticket.
 *
 * Each worktree signs in as its own user from a small pool (see
 * `e2eUserIndex`), once per run in `global-setup.ts`; `signIn` then reuses that
 * session. Concurrent runs sharing one user, and one new session per test,
 * piled up sessions until Clerk started ending new ones right after sign-in.
 */

const CLERK_API = "https://api.clerk.com/v1";

/** Pool slots picked from `E2E_PORT`; `E2E_USER_INDEX` may name any slot. */
export const E2E_USER_POOL_SIZE = 6;

/** Sessions idle for longer than this are revoked before each run. */
const STALE_SESSION_MS = 60 * 60 * 1000;

/** The slice of the browser `window.Clerk` singleton this helper uses. */
type ClerkWindow = Window & {
  Clerk?: {
    loaded: boolean;
    user: unknown;
    client: {
      signIn: {
        create(params: {
          strategy: "ticket";
          ticket: string;
        }): Promise<{ createdSessionId: string | null }>;
      };
    };
    setActive(params: { session: string | null }): Promise<void>;
  };
};

/** 1-based pool slot: `E2E_USER_INDEX`, else derived from the run's port. */
export const e2eUserIndex = () =>
  Number(process.env.E2E_USER_INDEX) ||
  (Number(process.env.E2E_PORT ?? 3113) % E2E_USER_POOL_SIZE) + 1;

export const E2E_EMAIL =
  process.env.E2E_EMAIL ??
  `codenaya-e2e-${e2eUserIndex()}+clerk_test@example.com`;

/** Browser state of the session `global-setup.ts` signs in (gitignored). */
export const AUTH_STATE_PATH = `playwright/.auth/${E2E_EMAIL}.json`;

export const hasClerkCredentials = () =>
  Boolean(
    process.env.CLERK_SECRET_KEY &&
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  );

const clerkApi = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(`${CLERK_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Clerk ${path} responded ${response.status}`);
  }
  return response.json() as Promise<T>;
};

/** Frontend API host, encoded in the publishable key (`pk_test_<base64 host$>`). */
const frontendApiHost = () => {
  const encoded = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY!.split("_")[2];
  return Buffer.from(encoded, "base64").toString().replace(/\$$/, "");
};

/** Finds this run's e2e test user, creating it on first use. */
export const ensureTestUser = async () => {
  const existing = await clerkApi<Array<{ id: string }>>(
    `/users?email_address=${encodeURIComponent(E2E_EMAIL)}`,
  );
  return (
    existing[0] ??
    (await clerkApi<{ id: string }>("/users", {
      method: "POST",
      body: JSON.stringify({
        email_address: [E2E_EMAIL],
        skip_password_requirement: true,
      }),
    }))
  );
};

/** Revokes the user's sessions left behind by earlier runs. */
export const revokeStaleSessions = async (userId: string) => {
  const sessions = await clerkApi<Array<{ id: string; last_active_at: number }>>(
    `/sessions?user_id=${userId}&status=active&limit=500`,
  );
  const staleBefore = Date.now() - STALE_SESSION_MS;
  for (const session of sessions) {
    if (session.last_active_at < staleBefore) {
      await clerkApi(`/sessions/${session.id}/revoke`, { method: "POST" });
    }
  }
};

/** Adds a testing token to Frontend API calls to get past bot protection. */
export const addTestingToken = async (page: Page) => {
  const { token: testingToken } = await clerkApi<{ token: string }>(
    "/testing_tokens",
    { method: "POST" },
  );
  await page.context().route(`https://${frontendApiHost()}/v1/**`, (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set("__clerk_testing_token", testingToken);
    route.continue({ url: url.toString() });
  });
};

const waitForClerk = (page: Page) =>
  page.waitForFunction(() => (window as ClerkWindow).Clerk?.loaded);

/** Starts a new session for `userId` with a one-time sign-in ticket. */
export const signInWithTicket = async (page: Page, userId: string) => {
  const { token: ticket } = await clerkApi<{ token: string }>(
    "/sign_in_tokens",
    {
      method: "POST",
      body: JSON.stringify({ user_id: userId, expires_in_seconds: 600 }),
    },
  );

  await page.goto("/");
  await waitForClerk(page);
  await page.evaluate(async (signInTicket) => {
    const clerk = (window as ClerkWindow).Clerk!;
    const result = await clerk.client.signIn.create({
      strategy: "ticket",
      ticket: signInTicket,
    });
    await clerk.setActive({ session: result.createdSessionId });
  }, ticket);
  await page.waitForFunction(() => Boolean((window as ClerkWindow).Clerk?.user));
};

/**
 * Signs the page in, reusing the run's session from `global-setup.ts` and
 * falling back to a fresh ticket sign-in when it is missing or ended.
 */
export const signIn = async (page: Page) => {
  await addTestingToken(page);

  if (existsSync(AUTH_STATE_PATH)) {
    const { cookies } = JSON.parse(readFileSync(AUTH_STATE_PATH, "utf8"));
    await page.context().addCookies(cookies);
    await page.goto("/");
    await waitForClerk(page);
    if (await page.evaluate(() => Boolean((window as ClerkWindow).Clerk?.user))) {
      return;
    }
  }

  const user = await ensureTestUser();
  await signInWithTicket(page, user.id);
};
