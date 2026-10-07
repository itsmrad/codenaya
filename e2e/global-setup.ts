import { chromium, type FullConfig } from "@playwright/test";

import { api } from "../convex/_generated/api";
import {
  addTestingToken,
  AUTH_STATE_PATH,
  ensureTestUser,
  hasClerkCredentials,
  revokeStaleSessions,
  signInWithTicket,
} from "./clerk-auth";
import { userConvexClient } from "./convex-client";

const FIXTURE_PROJECT_NAME = "e2e fixture";

/**
 * Signs this run's pool user in once and saves the session for `signIn`, then
 * points `E2E_PROJECT_ID` at that user's fixture project (unless `E2E_EMAIL`
 * pins a user, whose project `E2E_PROJECT_ID` already names).
 */
export default async function globalSetup(config: FullConfig) {
  if (!hasClerkCredentials()) return;

  const user = await ensureTestUser();
  await revokeStaleSessions(user.id);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ baseURL: config.projects[0].use.baseURL });
    await addTestingToken(page);
    await signInWithTicket(page, user.id);
    await page.context().storageState({ path: AUTH_STATE_PATH });

    if (!process.env.E2E_EMAIL && process.env.NEXT_PUBLIC_CONVEX_URL) {
      const client = await userConvexClient(page);
      const projects = await client.query(api.projects.get, {});
      process.env.E2E_PROJECT_ID =
        projects.find((project) => project.name === FIXTURE_PROJECT_NAME)?._id ??
        (await client.mutation(api.projects.create, { name: FIXTURE_PROJECT_NAME }));
    }
  } finally {
    await browser.close();
  }
}
