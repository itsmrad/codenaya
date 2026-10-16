"use server";

import { auth, clerkClient } from "@clerk/nextjs/server";

/**
 * Marks onboarding complete on the Clerk user object and saves preferred AI model.
 * Wrapped with try/catch so any temporary Clerk sync issue never blocks the user
 * from accessing their project workspace.
 */
export async function completeOnboarding(preferredModel: string) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return { success: false, reason: "not_authenticated" };
    }

    const client = await clerkClient();
    await client.users.updateUserMetadata(userId, {
      publicMetadata: {
        hasCompletedOnboarding: true,
        preferredModel,
      },
    });
    return { success: true };
  } catch (err) {
    console.warn("Failed to update user metadata in Clerk:", err);
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Marks onboarding as completed/skipped for users who do not want to create a project
 * right now. Prevents them from being redirected to /onboarding on subsequent visits.
 */
export async function skipOnboarding(preferredModel?: string) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return { success: false, reason: "not_authenticated" };
    }

    const client = await clerkClient();
    await client.users.updateUserMetadata(userId, {
      publicMetadata: {
        hasCompletedOnboarding: true,
        onboardingSkipped: true,
        ...(preferredModel ? { preferredModel } : {}),
      },
    });
    return { success: true };
  } catch (err) {
    console.warn("Failed to update user metadata for skip in Clerk:", err);
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

