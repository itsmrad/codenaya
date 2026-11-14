import { chromium } from "@playwright/test";
import { addTestingToken, ensureTestUser, findUsers, revokeStaleSessions, signInWithTicket } from "../../e2e/clerk-auth";
import { userConvexClient } from "../../e2e/convex-client";
import { assertDevTarget } from "./guard";

/** The existing Clerk user holding ADMIN_EMAIL. Looked up only, and the email is never printed. */
async function adminUser() {
  const email = process.env.ADMIN_EMAIL?.trim();
  if (!email) throw new Error("Missing ADMIN_EMAIL: run with Infisical dev");
  const users = await findUsers(email).catch(() => { throw new Error("Clerk user lookup for ADMIN_EMAIL failed"); });
  if (users.length !== 1) throw new Error(`ADMIN_EMAIL must match exactly one Clerk user, found ${users.length}`);
  return users[0];
}

export async function session(baseURL: string, asAdmin = false) {
  assertDevTarget(process.env, baseURL);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await addTestingToken(page);
    const user = asAdmin ? await adminUser() : await ensureTestUser("codenaya-eval-297+clerk_test@example.com");
    if (!asAdmin) await revokeStaleSessions(user.id); // Never end the admin's own sessions.
    await signInWithTicket(page, user.id);
    return { browser, page, user: await userConvexClient(page) };
  } catch (error) { await browser.close(); throw error; }
}
