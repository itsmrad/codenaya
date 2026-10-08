import type { Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

type ClerkSessionWindow = Window & {
  Clerk?: { session?: { getToken(options: { template: string }): Promise<string | null> } };
};

/** Convex client authenticated as the signed-in e2e user. */
export const userConvexClient = async (page: Page) => {
  const token = await page.evaluate(() =>
    (window as ClerkSessionWindow).Clerk!.session!.getToken({ template: "convex" }),
  );
  const client = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  client.setAuth(token!);
  return client;
};
