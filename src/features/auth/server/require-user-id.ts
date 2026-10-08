import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

type RequireUserIdResult =
  | { userId: string; unauthorized: undefined }
  | { userId: undefined; unauthorized: NextResponse };

/**
 * Resolves the signed-in Clerk user for a route handler. Signed-out callers get
 * the same `401 { error: "Unauthorized" }` JSON response from every API route:
 *
 *   const { userId, unauthorized } = await requireUserId();
 *   if (unauthorized) return unauthorized;
 */
export const requireUserId = async (): Promise<RequireUserIdResult> => {
  const { userId } = await auth();
  if (!userId) {
    return {
      userId: undefined,
      unauthorized: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  return { userId, unauthorized: undefined };
};
