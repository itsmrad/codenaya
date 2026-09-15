"use server";

import { auth, clerkClient } from "@clerk/nextjs/server";

/**
 * Marks onboarding complete on the Clerk user object, and stashes the
 * chosen AI model there too. There's no `users` table in Convex (schema
 * only has projects/files/conversations/etc, keyed by ownerId = Clerk's
 * user id string), so Clerk's publicMetadata is the natural home for this
 * until/unless a dedicated users table gets added.
 *
 * publicMetadata is only writable from the server (this file), and is
 * readable on the client via useUser() — safe for a non-sensitive flag
 * and preference like these.
 */
export async function completeOnboarding(preferredModel: string) {
  const { userId } = await auth();
  if (!userId) {
    throw new Error("Not authenticated");
  }

  const client = await clerkClient();
  await client.users.updateUserMetadata(userId, {
    publicMetadata: {
      hasCompletedOnboarding: true,
      preferredModel,
    },
  });
}
