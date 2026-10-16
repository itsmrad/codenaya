/**
 * Resets the hasCompletedOnboarding flag for your Clerk user
 * so you can re-test the onboarding flow.
 *
 * Usage:  npx tsx scripts/reset-onboarding.ts
 */

import { createClerkClient } from "@clerk/backend";

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY!,
});

const { data: users } = await clerk.users.getUserList({ limit: 10 });

if (users.length === 0) {
  console.log("No users found.");
  process.exit(1);
}

console.log("\nUsers:");
users.forEach((u, i) => {
  const email = u.emailAddresses?.[0]?.emailAddress ?? "(no email)";
  const done = u.publicMetadata?.hasCompletedOnboarding ? "✅" : "❌";
  console.log(`  ${i + 1}. ${email}  onboarding: ${done}  id: ${u.id}`);
});

// Reset the first user — change the index if you have multiple
const target = users[0];
console.log(
  `\nResetting onboarding for: ${target.emailAddresses?.[0]?.emailAddress ?? target.id}`
);

await clerk.users.updateUserMetadata(target.id, {
  publicMetadata: {
    hasCompletedOnboarding: false,
    preferredModel: undefined,
  },
});

console.log(
  "✅ Done! Refresh your app — you should see the onboarding wizard."
);
