/**
 * Resets the hasCompletedOnboarding flag for your Clerk user
 * so you can re-test the onboarding flow.
 *
 * Usage:  node scripts/reset-onboarding.mjs
 */

import { createClerkClient } from "@clerk/backend";
import { readFileSync } from "fs";

// Parse .env.local manually
const envFile = readFileSync(".env.local", "utf-8");
const envVars = {};
for (const line of envFile.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const idx = trimmed.indexOf("=");
  if (idx > 0) {
    envVars[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim().replace(/\r$/, "");
  }
}

const clerk = createClerkClient({
  secretKey: envVars.CLERK_SECRET_KEY,
});

const { data: users } = await clerk.users.getUserList({ limit: 10 });

if (users.length === 0) {
  console.log("No users found.");
  process.exit(1);
}

console.log("\nUsers:");
users.forEach((u, i) => {
  const email = u.emailAddresses?.[0]?.emailAddress ?? "(no email)";
  const done = u.publicMetadata?.hasCompletedOnboarding ? "✓" : "✗";
  console.log(`  ${i + 1}. ${email}  onboarding: ${done}  id: ${u.id}`);
});

// Reset the first user
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
  "Done! Refresh your app — you should see the onboarding wizard."
);
