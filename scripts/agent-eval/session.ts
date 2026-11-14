import { chromium } from "@playwright/test";
import { addTestingToken, ensureTestUser, findUsers, revokeSession, revokeStaleSessions, signInWithTicket } from "../../e2e/clerk-auth";
import { userConvexClient } from "../../e2e/convex-client";
import { assertDevTarget } from "./guard";

/** The existing Clerk user holding ADMIN_EMAIL. Looked up only, and the email is never printed. */
export async function adminUser() {
  const email = process.env.ADMIN_EMAIL?.trim();
  if (!email) throw new Error("Missing ADMIN_EMAIL: run with Infisical dev");
  const users = await findUsers(email).catch(() => { throw new Error("Clerk user lookup for ADMIN_EMAIL failed"); });
  if (users.length !== 1) throw new Error(`ADMIN_EMAIL must match exactly one Clerk user, found ${users.length}`);
  return users[0];
}

/** The user to build as. Only the eval test user's stale sessions are revoked, never the admin's. */
export async function evalUser(asAdmin: boolean) {
  if (asAdmin) return adminUser();
  const user = await ensureTestUser("codenaya-eval-297+clerk_test@example.com");
  await revokeStaleSessions(user.id);
  return user;
}

export async function session(baseURL: string, asAdmin = false) {
  assertDevTarget(process.env, baseURL);
  const browser = await chromium.launch();
  let sessionId: string | undefined;
  const close = async () => {
    // As the admin, end only the session this run created.
    if (asAdmin && sessionId) await revokeSession(sessionId).catch(() => console.error("Could not revoke this run's admin session"));
    await browser.close();
  };
  try {
    const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await addTestingToken(page);
    const user = await evalUser(asAdmin);
    sessionId = await signInWithTicket(page, user.id);
    return { close, page, user: await userConvexClient(page) };
  } catch (error) { await close(); throw error; }
}
