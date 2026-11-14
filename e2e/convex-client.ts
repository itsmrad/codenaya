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

/** Far more batches than any fixture project needs; past it, cleanup is stuck. */
const MAX_CLEANUP_BATCHES = 100;

/**
 * Empties a project. `system.cleanup` deletes in batches (file text first,
 * #412), so one call can leave files behind and a reseed then fails with
 * "File already exists" (#469). Calls it until it reports done, and fails
 * loudly instead of hanging if it never does.
 */
export const cleanupProject = async (
  system: ConvexHttpClient,
  internalKey: string,
  projectId: Id<"projects">,
) => {
  for (let batch = 0; batch < MAX_CLEANUP_BATCHES; batch++) {
    const { done } = await system.mutation(api.system.cleanup, { internalKey, projectId });
    if (done) return;
  }
  throw new Error(`system.cleanup did not finish project ${projectId} in ${MAX_CLEANUP_BATCHES} batches`);
};
