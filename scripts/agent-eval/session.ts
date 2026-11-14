import { chromium } from "@playwright/test";
import { addTestingToken, ensureTestUser, revokeStaleSessions, signInWithTicket } from "../../e2e/clerk-auth";
import { userConvexClient } from "../../e2e/convex-client";

export async function session(baseURL: string) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await addTestingToken(page);
    const user = await ensureTestUser("codenaya-eval-297+clerk_test@example.com");
    await revokeStaleSessions(user.id);
    await signInWithTicket(page, user.id);
    return { browser, page, user: await userConvexClient(page) };
  } catch (error) { await browser.close(); throw error; }
}
