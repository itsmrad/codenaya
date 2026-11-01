import type { Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

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

/**
 * Empties a project. `system.cleanup` deletes in batches (file text first,
 * #412), so one call can leave files behind and a reseed then fails with
 * "File already exists" (#469). Calls it until it reports done.
 */
export const cleanupProject = async (
  system: ConvexHttpClient,
  internalKey: string,
  projectId: Id<"projects">,
) => {
  let result;
  do {
    result = await system.mutation(api.system.cleanup, { internalKey, projectId });
  } while (!result.done);
};
