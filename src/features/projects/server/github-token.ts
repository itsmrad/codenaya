import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";

import { GITHUB_NOT_LINKED } from "../constants";

/**
 * Returns the user's GitHub OAuth token from their linked Clerk account, or
 * null when no GitHub account is linked.
 */
export async function getGithubToken(userId: string): Promise<string | null> {
  const client = await clerkClient();
  const tokens = await client.users.getUserOauthAccessToken(userId, "github");
  return tokens.data[0]?.token ?? null;
}

export function githubNotLinkedResponse() {
  return NextResponse.json(
    {
      error: "GitHub account not connected. Connect GitHub in your account settings.",
      code: GITHUB_NOT_LINKED,
    },
    { status: 400 }
  );
}
