import type { Page } from "@playwright/test";

/**
 * Signs a Clerk test user into the app without the UI.
 *
 * Uses the Clerk Backend API (needs `CLERK_SECRET_KEY` and
 * `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`): ensures the test user exists, adds a
 * testing token to Frontend API calls to get past bot protection, then signs in
 * with a one-time sign-in ticket.
 */

const CLERK_API = "https://api.clerk.com/v1";

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

export const E2E_EMAIL =
  process.env.E2E_EMAIL ?? "codenaya+clerk_test@example.com";

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

export const signIn = async (page: Page) => {
  const existing = await clerkApi<Array<{ id: string }>>(
    `/users?email_address=${encodeURIComponent(E2E_EMAIL)}`,
  );
  const user =
    existing[0] ??
    (await clerkApi<{ id: string }>("/users", {
      method: "POST",
      body: JSON.stringify({
        email_address: [E2E_EMAIL],
        skip_password_requirement: true,
      }),
    }));

  const { token: testingToken } = await clerkApi<{ token: string }>(
    "/testing_tokens",
    { method: "POST" },
  );
  await page.context().route(`https://${frontendApiHost()}/v1/**`, (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set("__clerk_testing_token", testingToken);
    route.continue({ url: url.toString() });
  });

  const { token: ticket } = await clerkApi<{ token: string }>(
    "/sign_in_tokens",
    {
      method: "POST",
      body: JSON.stringify({ user_id: user.id, expires_in_seconds: 600 }),
    },
  );

  await page.goto("/");
  await page.waitForFunction(() => (window as ClerkWindow).Clerk?.loaded);
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
